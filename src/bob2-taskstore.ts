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
// Schema + lifecycle confirmed against a live 2.0 store (2026-06-25, by reading a real dispatched task):
//   - `id`/`parent_id` are TEXT (uuids; migrated 1.x rows are `legacy-bob-code-*`), so correlation orders
//     by `created_at` (INTEGER epoch ms), NOT by id. `updated_at` is INTEGER epoch ms (same clock as ours).
//   - **Lifecycle is `active → running → active`** (watched live): a created task is 'active', flips to
//     'running' for the turn, then returns to 'active' when done (Bob never uses 'completed'). So the watch
//     gates on 'running' — while running it's NOT done even though `updated_at` bumps with gaps up to ~6.5s —
//     and settles once the row leaves 'running' AND goes quiet (`updated_at` still for `quietMs`).
//   - `last_error` is the **string `"null"`** (JSON of null) on a successful run, real JSON on a failure —
//     so "errored" means last_error is set AND not that sentinel.
//   - The workspace is in `env.workspace` (JSON), not the `directory` column (which is "").
//   - Result text + token costs live in a separate `messages` table / the `costs` column (V6).
// See docs/bob-2-inprocess.md and the auto-memory bob-2-taskstore-schema.

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

/** Bob is mid-turn on the task. Live lifecycle is active→running→active, so 'running' (and the transient
 *  'compacting') means NOT done — the watch must not settle while here, even across multi-second updated_at
 *  gaps within the turn. */
export function isActivelyRunning(status: string): boolean {
  return status === "running" || status === "compacting";
}

/** Hard terminal status. Rare/unobserved in practice (a done task returns to 'active') — kept as a
 *  belt-and-suspenders settle alongside the quiet-after-running rule, in case some task type does flip it. */
export function isTerminal(status: string): boolean {
  return status === "completed" || status === "error";
}

/** Bob's real error for the task, or null. last_error is the string "null" (JSON of null) on a SUCCESSFUL
 *  run and real JSON on a failure, so the literal "null" / "" sentinels are NOT errors. */
export function taskError(row: Bob2TaskRow): string | null {
  const e = row.last_error;
  return e != null && e !== "null" && e !== "" ? e : null;
}

/** Has the turn run at all? A freshly-created row has updated_at == created_at; it advances once Bob
 *  starts the turn. Distinguishes "created, not yet started" from "ran, now quiet" for the completion watch. */
export function hasRun(row: Bob2TaskRow): boolean {
  return row.created_at != null && row.updated_at != null && row.updated_at > row.created_at;
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
 * load. Settle rule (live-validated against the active→running→active lifecycle):
 *   - a real `last_error`, or a terminal status, settles immediately;
 *   - otherwise the turn is done once it is NOT running, HAS run (updated_at advanced past created_at, so
 *     we don't settle a created-but-unstarted row), AND has been quiet for `quietMs` (updated_at still).
 * Gating on 'running' is what makes the multi-second updated_at gaps *within* a turn safe; `quietMs` only
 * governs the not-running tail (post-turn, or a fast turn we never caught 'running'). Override via opts.isSettled.
 */
export async function awaitTurnSettled(
  store: Bob2TaskStore,
  id: string,
  opts: { pollMs?: number; timeoutMs?: number; quietMs?: number; isSettled?: (row: Bob2TaskRow) => boolean } = {},
): Promise<{ settled: boolean; row: Bob2TaskRow | null }> {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const quietMs = opts.quietMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = store.read(id);
    if (row) {
      const settled = opts.isSettled
        ? opts.isSettled(row)
        : taskError(row) != null ||
          isTerminal(row.status) ||
          (!isActivelyRunning(row.status) && hasRun(row) && Date.now() - (row.updated_at ?? 0) >= quietMs);
      if (settled) return { settled: true, row };
    }
    if (Date.now() >= deadline) return { settled: false, row };
    await sleep(pollMs);
  }
}
