import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bob2HomeDir } from "./bob2-config.js";

// Reader for Bob 2.0's task store (~/.bob/db/bob.db) — the only place a sibling extension can observe a
// dispatched task's progress: 2.0 exposes no event stream, and startTask returns no id. So we snapshot
// the existing root tasks, call startTask, then correlate OUR task as the new root that appeared, and
// poll its status. Read-only — we never write Bob's DB.
//
// Schema confirmed against a live 2.0 store (2026-06-25): `id` and `parent_id` are TEXT (uuids, plus
// `legacy-bob-code-*` for migrated 1.x tasks), so correlation orders by `created_at` (INTEGER epoch ms),
// NOT by id. Result text lives in a separate `messages` table (deferred to V6). The status lifecycle is
// only partly observable offline — all migrated rows sit at 'active' — so the completion watch settles
// conservatively on a hard terminal status or a non-null `last_error`, leaving the wall-clock as the
// backstop. See docs/bob-2-inprocess.md.

const requireModule = createRequire(import.meta.url);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Bob2TaskStatus = "active" | "running" | "compacting" | "paused" | "completed" | "error";

export interface Bob2TaskRow {
  id: string;
  parent_id: string | null;
  /** A Bob2TaskStatus value — but Bob owns the column, so keep the type wide. */
  status: string;
  directory: string | null;
  /** Epoch-ms timestamps (INTEGER). created_at is the monotonic correlation key; updated_at feeds V6's watchdog. */
  created_at: number | null;
  updated_at: number | null;
  /** JSON token/cost accounting; the best-effort budget signal on 2.0 (V6). */
  costs: string | null;
  /** Bob records a failed turn here; non-null = the task errored even if `status` hasn't flipped. */
  last_error: string | null;
}

export function bob2DbPath(): string {
  return join(bob2HomeDir(), "db", "bob.db");
}

/** Does Bob 2.0's task store exist yet? A non-throwing probe for the 1.x↔2.x driver detection and for
 *  telling a legitimately-absent db (cold start, before the first task) from an unopenable one. */
export function bob2DbExists(path = bob2DbPath()): boolean {
  return existsSync(path);
}

/** Hard terminal: the task won't run again without new input. */
export function isTerminal(status: string): boolean {
  return status === "completed" || status === "error";
}

/** The dispatched turn has settled (won't progress without input): a terminal status, or Bob recorded an
 *  error. Deliberately does NOT treat 'active'/'running'/'paused' as settled — the live status lifecycle
 *  is unverified, so we never infer completion from a non-terminal state (the wall-clock is the backstop). */
export function isRowSettled(row: Bob2TaskRow): boolean {
  return isTerminal(row.status) || row.last_error != null;
}

const COLS = "id, parent_id, status, directory, created_at, updated_at, costs, last_error";

export class Bob2TaskStore {
  // Prepared statements are memoized: the completion watch reads the same row once per poll (hundreds of
  // times over a long dispatch), so re-preparing each call would re-parse the SQL every poll.
  private readonly stmts = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Open the live store read-only (we never write Bob's DB). Caller checks bob2DbExists first for the
   *  cold-start case; here a missing file still throws a clear error rather than an opaque SQLITE one. */
  static open(path = bob2DbPath()): Bob2TaskStore {
    if (!existsSync(path)) throw new Error(`Bob 2.0 task store not found at ${path}`);
    const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
    return new Bob2TaskStore(new DatabaseSync(path, { readOnly: true }));
  }

  /**
   * Snapshot the existing root tasks BEFORE startTask, so the row that appears after is ours. `sinceMs`
   * is the newest root's created_at; `ids` are the root ids AT that timestamp (the only pre-existing
   * rows a `created_at >= sinceMs` correlation query can return), so newRootSince can exclude them even
   * when our task lands in the same millisecond.
   */
  snapshotRoots(): { ids: Set<string>; sinceMs: number } {
    const max = this.q("SELECT COALESCE(MAX(created_at), 0) AS m FROM tasks WHERE parent_id IS NULL").get() as {
      m: number;
    };
    const rows = this.q("SELECT id FROM tasks WHERE parent_id IS NULL AND created_at = ?").all(max.m) as {
      id: string;
    }[];
    return { ids: new Set(rows.map((r) => r.id)), sinceMs: max.m };
  }

  /**
   * The newest root task created since the snapshot whose id wasn't already there — i.e. OUR dispatch.
   * Subtasks (parent_id set) are excluded so we watch the root turn. id is a uuid, so created_at orders.
   */
  newRootSince(seen: Set<string>, sinceMs: number): Bob2TaskRow | null {
    const rows = this.q(
      `SELECT ${COLS} FROM tasks WHERE parent_id IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 16`,
    ).all(sinceMs) as unknown as Bob2TaskRow[];
    return rows.find((r) => !seen.has(r.id)) ?? null;
  }

  read(id: string): Bob2TaskRow | null {
    const row = this.q(`SELECT ${COLS} FROM tasks WHERE id = ?`).get(id) as Bob2TaskRow | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Poll a task row until the dispatched turn settles, or the wall-clock elapses (`settled:false` → the
 * driver maps that to a 'timeout'). Polling, not events (2.0 exposes none); pollMs trades latency for DB
 * load. Settles on isRowSettled (terminal status or last_error) — never on a non-terminal state, since
 * the live lifecycle is unverified. Override the rule via opts.isSettled (takes the row).
 */
export async function awaitTurnSettled(
  store: Bob2TaskStore,
  id: string,
  opts: { pollMs?: number; timeoutMs?: number; isSettled?: (row: Bob2TaskRow) => boolean } = {},
): Promise<{ settled: boolean; row: Bob2TaskRow | null }> {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const settledRule = opts.isSettled ?? isRowSettled;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.read(id);
    if (row && settledRule(row)) return { settled: true, row };
    if (Date.now() >= deadline) return { settled: false, row };
    await sleep(pollMs);
  }
}
