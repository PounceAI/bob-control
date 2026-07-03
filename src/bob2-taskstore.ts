import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bob2HomeDir } from "./bob2-config.js";
import { sameWorkspace } from "./pipe-name.js";

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
//   - Result text = the latest `assistant` row's `data.content` in the `messages` table; token/cost
//     accounting is the `costs` column JSON (input/output/cacheRead/cacheWrite/cost). Both read by
//     readResultText / parseCosts.
// See docs/bob-2-inprocess.md and the auto-memory bob-2-taskstore-schema.

const requireModule = createRequire(import.meta.url);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Completion-watch tuning, single-sourced (the in-process driver imports these). Measured 2026-06-30
// against the live 2.0 loop: the board went terminal a flat ~9.3s after Bob's visible completion (the
// root leaving 'running'), independent of turn length — ~8s of it this quiet debounce, ~1s detection.
// Bob writes the result text within ~0.3s of the status flip, so a 2s quiet keeps a ~6x margin over
// that tail while cutting most of the dead time; a 400ms poll tightens detection without loading the db.
export const DEFAULT_QUIET_MS = 2000;
export const DEFAULT_POLL_MS = 400;

export interface Bob2TaskRow {
  id: string;
  parent_id: string | null;
  /** Live values active/running/compacting/paused/completed/error — but Bob owns the column, keep it wide. */
  status: string;
  directory: string | null;
  /** Epoch-ms timestamps (INTEGER). created_at is the monotonic correlation key; updated_at feeds the stall watchdog. */
  created_at: number | null;
  updated_at: number | null;
  /** JSON token/cost accounting; the best-effort budget signal on 2.0. */
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

/** Token/cost accounting parsed from the `costs` column JSON (live shape: input/output/cacheRead/
 *  cacheWrite token counts + `cost` in USD). `output` matches DispatchResult.tokensUsed's 1.x semantics. */
export interface Bob2Costs {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

const finiteNum = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** Parse the `costs` JSON, or null if absent/unparseable (best-effort budget — never fail a dispatch on it). */
export function parseCosts(raw: string | null): Bob2Costs | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    return {
      input: finiteNum(c.input),
      output: finiteNum(c.output),
      cacheRead: finiteNum(c.cacheRead),
      cacheWrite: finiteNum(c.cacheWrite),
      cost: finiteNum(c.cost),
    };
  } catch {
    return null;
  }
}

/** Does a row's `first_message` look like the prompt we dispatched? Bob stores our content verbatim, so
 *  this tells OUR new root apart from a concurrent dispatch by ANOTHER Bob window on the shared global db.
 *
 *  Rule (whitespace-collapsed): first_message must CONTAIN our FULL content — covers the exact case and
 *  Bob's observed mask-prefix ("[mask] <content>"). We require the WHOLE prompt, never a prefix of it, so a
 *  foreign task that merely shares our opening chars can't hijack the correlation poll on the shared bob.db
 *  (cross-window task confusion — CWE-284). Both looser branches are gone: the original
 *  `a.includes(b.slice(0,120))` matched on a 120-char prefix, and `b.startsWith(a)` matched when a SHORT
 *  foreign first_message was a prefix of our prompt — each a partial-knowledge confusion vector. If Bob ever
 *  truncated first_message (unobserved — the schema stores it verbatim) this would fail to correlate and the
 *  dispatch would abort: a SAFE failure (we never grab a stranger's task), preferable to a loose match. */
export function firstMessageMatches(firstMessage: string | null | undefined, content: string): boolean {
  if (!firstMessage) return false;
  const a = firstMessage.replace(/\s+/g, " ").trim();
  const b = content.replace(/\s+/g, " ").trim();
  if (!b) return false;
  return a.includes(b); // full-content containment (a === b is subsumed)
}

/** The `workspace` fsPath out of a task's `env` JSON (live shape: {id,workspace,scheme,…}), or null. */
function envWorkspace(env: string | null): string | null {
  if (!env) return null;
  try {
    const w = (JSON.parse(env) as { workspace?: unknown }).workspace;
    return typeof w === "string" ? w : null;
  } catch {
    return null;
  }
}

/** Flatten a message `content` (string, or an array of text blocks) to plain text; null when empty. */
function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const t = content
      .map((b) =>
        typeof b === "string"
          ? b
          : typeof (b as { text?: unknown })?.text === "string"
            ? (b as { text: string }).text
            : "",
      )
      .join("")
      .trim();
    return t || null;
  }
  return null;
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
   * OUR dispatched root among the new roots created since the snapshot (subtasks excluded; created_at
   * orders). ONE new root ⇒ ours — startTask resolves only after Bob creates the row, so a lone new root
   * can only be ours. TWO+ new roots ⇒ a concurrent dispatch from ANOTHER Bob window shares this global
   * db, so pick the one whose `first_message` matches our `content`; null if none match yet, so the caller
   * keeps polling rather than grabbing a stranger's task. With no `content` (legacy) it is newest-wins.
   */
  newRootSince(seen: Set<string>, sinceMs: number, content?: string): Bob2TaskRow | null {
    const rows = this.q(
      `SELECT ${COLS}, first_message FROM tasks WHERE parent_id IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 16`,
    ).all(sinceMs) as unknown as (Bob2TaskRow & { first_message: string | null })[];
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (fresh.length <= 1) return fresh[0] ?? null; // no concurrency — the lone new root is ours
    if (content) return fresh.find((r) => firstMessageMatches(r.first_message, content)) ?? null;
    return fresh[0]; // legacy callers with no content to match on: newest-wins
  }

  read(id: string): Bob2TaskRow | null {
    const row = this.q(`SELECT ${COLS} FROM tasks WHERE id = ?`).get(id) as Bob2TaskRow | undefined;
    return row ?? null;
  }

  /**
   * Defer-while-chatting signal (2.0): is anyone OTHER than us chatting with Bob in `workspace` now (or just
   * now)? The 2.0 analog of 1.x's IPC activity stream, read from bob.db. Two probes over FOREIGN roots
   * (parent_id IS NULL, id ∉ `ownIds`, same workspace) — bounded by TIME, not by a fixed row count, so a
   * busy shared db can't push the row we care about out of a LIMIT window:
   *   - `running`: a root actively running AND bumped since `runningSinceMs` — the staleness clamp self-heals
   *     a crashed window's stuck 'running' row instead of wedging defer forever (the 1.x evictStale role);
   *   - `activeRecently`: any root touched since `activeSinceMs` — the idle-grace window that keeps the
   *     worker from barging in the instant the user stops typing.
   * Workspace-scoped because bob.db is GLOBAL across all Bob windows — an unrelated project's chat must not
   * pause this one; with no workspace we can't attribute a chat to our window, so report nothing rather than
   * defer on a stranger. The status filter and time-bounds run in SQL, so the common no-chat poll matches ~0
   * rows; `sameWorkspace` is pipe-name's one canonical "same folder" rule (so a row with no/unparseable env
   * — which we can't attribute — is treated as not-ours).
   */
  foreignActivity(
    ownIds: Set<string>,
    workspace: string | null,
    cutoffs: { activeSinceMs: number; runningSinceMs: number },
  ): { running: boolean; activeRecently: boolean } {
    if (!workspace) return { running: false, activeRecently: false };
    // A row counts as someone-else-chatting when it's FOREIGN (not one we dispatched) AND in our workspace.
    const foreign = (r: { id: string; env: string | null }): boolean =>
      !ownIds.has(r.id) && sameWorkspace(envWorkspace(r.env), workspace);
    // status IN (...) mirrors isActivelyRunning — keep the two in sync.
    const running = (
      this.q(
        "SELECT id, env FROM tasks WHERE parent_id IS NULL AND status IN ('running', 'compacting') AND updated_at >= ?",
      ).all(cutoffs.runningSinceMs) as { id: string; env: string | null }[]
    ).some(foreign);
    const activeRecently = (
      this.q("SELECT id, env FROM tasks WHERE parent_id IS NULL AND updated_at >= ?").all(cutoffs.activeSinceMs) as {
        id: string;
        env: string | null;
      }[]
    ).some(foreign);
    return { running, activeRecently };
  }

  /** Bob's completion summary for the task: the latest `assistant` message's `content` (the result text
   *  2.0 doesn't return from startTask). Read from the `messages` table (id/task_id/role/data JSON).
   *  Best-effort — null when no assistant message exists or the row won't parse (never throws). */
  readResultText(id: string): string | null {
    try {
      const row = this.q(
        "SELECT data FROM messages WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
      ).get(id) as { data: string } | undefined;
      if (!row) return null;
      return extractText((JSON.parse(row.data) as { content?: unknown }).content);
    } catch {
      return null;
    }
  }

  /** The task's assistant messages joined oldest→newest — for review read-back. A review's findings sit in
   *  an EARLIER message than readResultText's last one (which is Bob's closing summary), so the structured
   *  parser must see the whole transcript, not just the tail. Per-row parse guard: one bad row can't drop
   *  the rest. Best-effort — null when there are no assistant messages (never throws). */
  readReviewText(id: string): string | null {
    try {
      const rows = this.q(
        "SELECT data FROM messages WHERE task_id = ? AND role = 'assistant' ORDER BY created_at ASC",
      ).all(id) as { data: string }[];
      const parts: string[] = [];
      for (const r of rows) {
        try {
          const t = extractText((JSON.parse(r.data) as { content?: unknown }).content);
          if (t) parts.push(t);
        } catch {
          /* skip a malformed row, keep the rest */
        }
      }
      return parts.length ? parts.join("\n\n") : null;
    } catch {
      return null;
    }
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
): Promise<{ settled: boolean; row: Bob2TaskRow | null; maxGapMs: number }> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const deadline = Date.now() + timeoutMs;
  // Stall-watchdog telemetry: the largest gap (ms) between consecutive `updated_at` bumps that ended a
  // running stretch — i.e. how long Bob can be silent yet still working. prevRunning qualifies the gap by
  // the status DURING it (the prior poll), so the active-tail bump after a turn doesn't inflate it.
  let prevUpdated: number | null = null;
  let prevRunning = false;
  let maxGapMs = 0;
  for (;;) {
    const row = store.read(id);
    if (row) {
      const u = row.updated_at;
      if (u != null && prevUpdated != null && u > prevUpdated && prevRunning)
        maxGapMs = Math.max(maxGapMs, u - prevUpdated);
      if (u != null) prevUpdated = u;
      prevRunning = isActivelyRunning(row.status);
      const settled = opts.isSettled
        ? opts.isSettled(row)
        : taskError(row) != null ||
          isTerminal(row.status) ||
          (!isActivelyRunning(row.status) && hasRun(row) && Date.now() - (row.updated_at ?? 0) >= quietMs);
      if (settled) return { settled: true, row, maxGapMs };
    }
    if (Date.now() >= deadline) return { settled: false, row, maxGapMs };
    await sleep(pollMs);
  }
}
