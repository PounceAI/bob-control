import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bob2HomeDir } from "./bob2-config.js";

// Reader for Bob 2.0's task store (~/.bob/db/bob.db) — the only place a sibling extension can observe
// a dispatched task's progress: 2.0 exposes no event stream, and startTask returns no id. So we
// correlate OUR dispatch by directory + a baseline id, then poll its status. Read-only — we never
// write Bob's DB. The `directory` filter must match the exact string Bob writes (Windows
// case/separator/trailing-slash); V5 normalizes to Bob's form. UNVERIFIED against a live 2.0 (V7) —
// see docs/bob-2-inprocess.md.

const requireModule = createRequire(import.meta.url);

export type Bob2TaskStatus = "active" | "running" | "compacting" | "paused" | "completed" | "error";

export interface Bob2TaskRow {
  id: number;
  parent_id: number | null;
  /** A Bob2TaskStatus value — but Bob owns the column, so keep the type wide. */
  status: string;
  directory: string | null;
  updated_at: string | null;
  /** JSON token/cost accounting; the best-effort budget signal on 2.0 (no api_req events to sum). */
  costs: string | null;
}

export function bob2DbPath(): string {
  return join(bob2HomeDir(), "db", "bob.db");
}

/** Does Bob 2.0's task store exist yet? A non-throwing probe for the 1.x↔2.x driver detection. */
export function bob2DbExists(path = bob2DbPath()): boolean {
  return existsSync(path);
}

/** Bob is actively churning on the task (vs. idle/terminal). A dispatch waits for this to clear. */
export function isActivelyRunning(status: string): boolean {
  return status === "running" || status === "compacting";
}

/** Hard terminal: the task won't run again without new input. */
export function isTerminal(status: string): boolean {
  return status === "completed" || status === "error";
}

const COLS = "id, parent_id, status, directory, updated_at, costs";

export class Bob2TaskStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Open the live store read-only (we never write Bob's DB). */
  static open(path = bob2DbPath()): Bob2TaskStore {
    // readOnly never creates the file, so a missing bob.db throws an opaque SQLITE error. Guard it so
    // the 1.x↔2.x detection gets a clear signal to fall back on (Bob 2.0 absent / no task has run).
    if (!existsSync(path)) throw new Error(`Bob 2.0 task store not found at ${path}`);
    const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
    return new Bob2TaskStore(new DatabaseSync(path, { readOnly: true }));
  }

  /** Highest task id in a directory — snapshot this BEFORE startTask so the new row is the one id > it. */
  maxIdInDir(directory: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM tasks WHERE directory = ?").get(directory) as {
      m: number;
    };
    return row.m;
  }

  /**
   * The root task created in a directory after a baseline id — how we correlate OUR dispatch (startTask
   * returns no id). Newest root wins; subtasks (parent_id set) are excluded so we watch the root turn.
   */
  newRootTaskSince(directory: string, sinceId: number): Bob2TaskRow | null {
    const sql = `SELECT ${COLS} FROM tasks WHERE directory = ? AND id > ? AND parent_id IS NULL ORDER BY id DESC LIMIT 1`;
    const row = this.db.prepare(sql).get(directory, sinceId) as Bob2TaskRow | undefined;
    return row ?? null;
  }

  read(id: number): Bob2TaskRow | null {
    const row = this.db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`).get(id) as Bob2TaskRow | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Poll a task row until the dispatched turn settles, or the wall-clock elapses (`settled:false` → the
 * driver maps that to a 'timeout'). Polling, not events (2.0 exposes none); pollMs trades latency for
 * DB load. On `settled:true` the caller inspects `row.status` to map the outcome: completed vs `error`
 * (→ aborted) vs `active`/`paused` (idle / wedged-on-prompt).
 *
 * The default gates on having SEEN the task running, then stop. A freshly-created row sits in 'active'
 * BEFORE Bob starts the turn, so a naive "not running ⇒ done" would false-complete on the first poll.
 * So: wait for running/compacting, then settle once it leaves that — or settle immediately on a hard
 * terminal status (a turn too fast to catch running). Override the whole rule via opts.isSettled.
 */
export async function awaitTurnSettled(
  store: Bob2TaskStore,
  id: number,
  opts: { pollMs?: number; timeoutMs?: number; isSettled?: (status: string) => boolean } = {},
): Promise<{ settled: boolean; row: Bob2TaskRow | null }> {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;
  for (;;) {
    const row = store.read(id);
    if (row) {
      if (opts.isSettled) {
        if (opts.isSettled(row.status)) return { settled: true, row };
      } else if (isActivelyRunning(row.status)) {
        sawRunning = true;
      } else if (sawRunning || isTerminal(row.status)) {
        return { settled: true, row };
      }
    }
    if (Date.now() >= deadline) return { settled: false, row };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
