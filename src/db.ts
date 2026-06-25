import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task, TaskNote, TaskStatus, TaskPriority, TaskArtifact, ArtifactKind, TaskCheckpoint } from "./types.js";
import { CLAIMABLE_STATUS, isCompleted, isFinished, TASK_STATUSES } from "./types.js";
import { estimateTaskScope } from "./scope.js";
import { looksLikeImplementation } from "./modes.js";

// Subsystems extracted from db.ts into cohesive modules (they reuse db's connection + helpers).
// Re-exported here so the public db API is unchanged for the ~12 modules that import from "./db.js".
export * from "./questions.js"; // the board-native ask/answer round-trip
export * from "./completion.js"; // the done-integrity gate (completeTask + Evidence)

// Required lazily in getDb so the warning suppressor runs before node:sqlite loads.
const requireModule = createRequire(import.meta.url);

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Map a worktree dir to the board it shares (the MAIN worktree's data/tasks.db), so concurrent linked
 * worktrees of one repo drain ONE queue. Sync (no git spawn) — defaultDbPath must stay sync — by reading
 * `<dir>/.git`:
 *   - a `.git` DIRECTORY → this is the main worktree (or a plain clone): board lives right here.
 *   - a `.git` FILE → `gitdir: <main>/.git/worktrees/<name>`; strip `/.git/worktrees/<name>` → `<main>`.
 * Returns null when `dir` isn't a git worktree at all, so the caller falls through to per-dir resolution.
 */
export function sharedWorktreeBoard(dir: string): string | null {
  const gitPath = join(dir, ".git");
  let st;
  try {
    st = statSync(gitPath);
  } catch {
    return null; // no .git → not a worktree
  }
  if (st.isDirectory()) return resolve(dir, "data", "tasks.db");
  let content: string;
  try {
    content = readFileSync(gitPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!content.startsWith("gitdir:")) return null;
  // gitdir may be relative to the worktree dir; resolve, fold to forward slashes, strip the suffix.
  const gitdir = resolve(dir, content.slice(7).trim().replace(/\\/g, "/")).replace(/\\/g, "/");
  const marker = gitdir.toLowerCase().lastIndexOf("/.git/worktrees/");
  if (marker === -1) return null;
  return resolve(gitdir.slice(0, marker), "data", "tasks.db");
}

// SQLite path resolution, in order:
//   1. BOB_TASKS_DB             — explicit path wins.
//   2. BOB_TASKS_PORTABLE       — a shared board in the user's home (~/.bob-tasks/tasks.db),
//      so the Claude Code plugin and Bob can agree on one queue from any repo.
//   3. BOB_TASKS_WORKTREE_SHARED — opt-in: every linked worktree resolves the MAIN worktree's board
//      (base = CLAUDE_PROJECT_DIR or cwd). A no-op for a plain clone / non-git dir (resolves to its own
//      data/tasks.db, same as 4), so it only changes behavior for actual linked worktrees.
//   4. CLAUDE_PROJECT_DIR       — the open project's <dir>/data/tasks.db. Claude Code sets this in every
//      MCP server it spawns (plugin AND a terminal/project .mcp.json), so a terminal-configured
//      server lands on the SAME project board the plugin does without an explicit BOB_TASKS_DB —
//      otherwise the module-relative fallback (5) reads a different board than the worker writes.
//   5. else                     — the repo-local <project-root>/data/tasks.db (module-relative).
export function defaultDbPath(): string {
  // .trim() so a whitespace-only value doesn't resolve to a bogus path ("" is already falsy).
  const explicit = process.env.BOB_TASKS_DB?.trim();
  if (explicit) return resolve(explicit);
  if (process.env.BOB_TASKS_PORTABLE) return resolve(homedir(), ".bob-tasks", "tasks.db");
  const projectDir = process.env.CLAUDE_PROJECT_DIR?.trim();
  if (process.env.BOB_TASKS_WORKTREE_SHARED) {
    const shared = sharedWorktreeBoard(projectDir || process.cwd());
    if (shared) return shared; // not a git worktree → fall through to per-dir resolution below
  }
  if (projectDir) return resolve(projectDir, "data", "tasks.db");
  return resolve(moduleDir, "..", "data", "tasks.db");
}

let db: DatabaseSync | null = null;

// Singleton SQLite handle. `path` is only honored on the first call; later
// calls ignore it and return the existing handle.
export function getDb(path = defaultDbPath()): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  // The board is per-project state, never source: keep it out of the consuming repo's
  // git status so it can't land as untracked tasks.db* at a repo root.
  ensureGitignore(path);
  const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // busy_timeout retries a transient "database is locked" instead of throwing; Bob
  // keeps several concurrent connections on this board. Access it from the Windows
  // side only -- WAL's shared memory can't cross the WSL/Windows boundary.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/**
 * Run `fn` inside a single IMMEDIATE write transaction: it commits atomically on success and
 * ROLLBACKs on any throw, so a multi-step mutation can never leave a half-applied board (a crash
 * or validation error between writes undoes them all). IMMEDIATE takes the write lock up front, so
 * concurrent writers serialize cleanly (waiting out `busy_timeout`) instead of racing a deferred
 * snapshot. NOT reentrant — callers must not nest transaction() calls (SQLite has no nested BEGIN).
 */
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* nothing to roll back / already rolled back */
    }
    throw err;
  }
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      priority    TEXT NOT NULL DEFAULT 'medium',
      tags        TEXT NOT NULL DEFAULT '[]',
      mode        TEXT,
      assignee    TEXT,
      result      TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author     TEXT,
      note       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_notes_task ON task_notes(task_id);

    -- Board-level flags (e.g. the armed/disarmed dispatch gate). Generic key/value.
    CREATE TABLE IF NOT EXISTS board_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Execution artifacts a worker recorded per task: files written, commits, test
    -- results. Serves both delete-safety (warn on orphaned side effects) and the
    -- done-integrity gate (a task is only 'done' with evidence here).
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      path       TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(task_id);

    -- Human-input questions a worker raised on the board + their answer round-trip.
    -- The worker polls for an answer by question_id; any board client answers it.
    CREATE TABLE IF NOT EXISTS task_questions (
      question_id TEXT PRIMARY KEY,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      options     TEXT NOT NULL DEFAULT '[]',
      status      TEXT NOT NULL DEFAULT 'open',
      answer      TEXT,
      asked_at    TEXT NOT NULL,
      answered_at TEXT,
      deadline_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_questions_task ON task_questions(task_id);
    -- Open-question lookups (getOpenQuestion / listOpenQuestions) filter by status and order
    -- by asked_at; the table is never pruned (rows flip to answered/timed_out), so index it.
    CREATE INDEX IF NOT EXISTS idx_questions_open ON task_questions(status, asked_at);

    -- Worker liveness: a draining worker upserts its heartbeat here so board_status (and the
    -- dispatch skills' await_task) can tell whether anything is servicing the board.
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      worker_id  TEXT PRIMARY KEY,
      assignee   TEXT,
      pid        INTEGER,
      worktree   TEXT,
      started_at TEXT NOT NULL,
      last_beat  TEXT NOT NULL
    );
  `);

  // node:sqlite has no "ADD COLUMN IF NOT EXISTS", so probe and add what's missing.
  addColumnIfMissing(d, "tasks", "mode", "TEXT");
  addColumnIfMissing(d, "tasks", "depends_on", "TEXT");
  addColumnIfMissing(d, "tasks", "retry_attempts", "INTEGER DEFAULT 0");
  addColumnIfMissing(d, "tasks", "checkpoint", "TEXT");
  addColumnIfMissing(d, "tasks", "estimated_tokens", "INTEGER");
  addColumnIfMissing(d, "worker_heartbeats", "worktree", "TEXT"); // T7 worktree lease
}

/**
 * Write a .gitignore next to the board DB so its files never appear as untracked
 * state in a consuming repo. Idempotent and best-effort (a read-only dir is fine).
 */
function ensureGitignore(dbPath: string): void {
  try {
    const dir = dirname(dbPath);
    const base = basename(dbPath);
    const wanted = [base, `${base}-wal`, `${base}-shm`, `${base}-journal`];
    const giPath = join(dir, ".gitignore");
    let existing = "";
    try {
      existing = readFileSync(giPath, "utf8");
    } catch {
      /* no .gitignore yet */
    }
    // Respect existing patterns (incl. simple globs like *.db / *.db-wal / tasks.db*)
    // so we don't append redundant lines on every open in a repo that already ignores them.
    const patterns = existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const covered = (t: string): boolean =>
      patterns.some(
        (p) =>
          p === t ||
          p === "*" ||
          (p.startsWith("*") && t.endsWith(p.slice(1))) ||
          (p.endsWith("*") && t.startsWith(p.slice(0, -1))),
      );
    const missing = wanted.filter((w) => !covered(w));
    if (missing.length === 0) return;
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(giPath, existing + prefix + missing.join("\n") + "\n");
  } catch {
    /* best-effort: never block board open on a gitignore write */
  }
}

function addColumnIfMissing(d: DatabaseSync, table: string, column: string, type: string): void {
  // Identifiers/types can't be bound as params, so they're interpolated. Only
  // call with hardcoded literals; the guard turns user input into a hard failure.
  const SAFE = /^[A-Za-z_][A-Za-z0-9_ ]*$/;
  if (!SAFE.test(table) || !SAFE.test(column) || !SAFE.test(type)) {
    throw new Error(`addColumnIfMissing: unsafe identifier (${table}.${column} ${type})`);
  }
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Tags are a JSON array string; tolerate malformed/legacy values instead of throwing.
export function parseTags(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// Dependencies are a JSON array of task IDs; tolerate malformed/legacy values instead of throwing.
function parseDependsOn(raw: unknown): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as number[]).filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

// Detect cycles in task dependencies using DFS. Returns an error message if a cycle is found, null otherwise.
function detectCycle(d: DatabaseSync, taskId: number, newDeps: number[]): string | null {
  // Self-dependency is a cycle
  if (newDeps.includes(taskId)) {
    return `Task #${taskId} cannot depend on itself`;
  }

  // Build a dependency graph including the proposed change
  const graph = new Map<number, number[]>();
  const rows = d.prepare("SELECT id, depends_on FROM tasks").all() as Array<{ id: number; depends_on: unknown }>;
  for (const row of rows) {
    const deps = row.id === taskId ? newDeps : parseDependsOn(row.depends_on);
    graph.set(Number(row.id), deps);
  }

  // DFS to detect cycles starting from any dependency of taskId
  const visited = new Set<number>();
  const recStack = new Set<number>();

  function hasCycle(node: number): number[] | null {
    if (recStack.has(node)) {
      // Found a cycle - return the path
      return [node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    recStack.add(node);

    const deps = graph.get(node) ?? [];
    for (const dep of deps) {
      const cyclePath = hasCycle(dep);
      if (cyclePath) {
        cyclePath.unshift(node);
        return cyclePath;
      }
    }

    recStack.delete(node);
    return null;
  }

  // Check if adding these dependencies would create a cycle
  for (const dep of newDeps) {
    visited.clear();
    recStack.clear();
    recStack.add(taskId); // Start with taskId in the recursion stack
    const cyclePath = hasCycle(dep);
    if (cyclePath) {
      cyclePath.unshift(taskId);
      return `Dependency cycle detected: ${cyclePath.map((id) => `#${id}`).join(" → ")}`;
    }
  }

  return null;
}

// node:sqlite returns plain row objects; map them to our typed shape.
function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: Number(r.id),
    title: String(r.title),
    description: (r.description as string) ?? null,
    status: r.status as TaskStatus,
    priority: r.priority as TaskPriority,
    tags: parseTags(r.tags),
    mode: (r.mode as string) ?? null,
    assignee: (r.assignee as string) ?? null,
    result: (r.result as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    depends_on: parseDependsOn(r.depends_on),
    retry_attempts: Number(r.retry_attempts ?? 0),
    estimated_tokens: r.estimated_tokens == null ? null : Number(r.estimated_tokens),
  };
}

function rowToNote(r: Record<string, unknown>): TaskNote {
  return {
    id: Number(r.id),
    task_id: Number(r.task_id),
    author: (r.author as string) ?? null,
    note: String(r.note),
    created_at: String(r.created_at),
  };
}

// Sort key: priority bucket first, then oldest-first within a bucket.
const PRIORITY_SQL = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  tags?: string[];
  /** Bob mode slug, or null/undefined to let the dispatcher auto-route. */
  mode?: string | null;
  /** Task IDs this task depends on. */
  depends_on?: number[];
  /** Create non-pullable ('staged'). Release to 'pending' deliberately with releaseTasks. */
  staged?: boolean;
  /** Override the auto-computed single-dispatch token estimate (see scope.ts). */
  estimated_tokens?: number | null;
}

export function createTask(input: CreateTaskInput): Task {
  const d = getDb();
  const deps = input.depends_on ?? [];

  // Right-size the task before it lands (see scope.ts): estimate its single-dispatch token scope so
  // the worker can enforce a budget ceiling, and an oversized task is flagged — or routed to
  // orchestrator, which decomposes it into subtasks — rather than dispatched doomed to a mid-work
  // timeout that strands partial work.
  const scope = estimateTaskScope({ title: input.title, description: input.description, mode: input.mode });
  const estimatedTokens = input.estimated_tokens ?? scope.tokens;
  let mode = input.mode ?? null;
  let tags = input.tags ?? [];
  // Auto-route an oversized IMPLEMENTATION task that has no explicit mode to orchestrator. Don't
  // override a mode the creator chose, don't push read-only/analysis intent into a write-capable mode,
  // and don't reroute a STAGED task — it's under deliberate curation, so flag it and let the curator
  // decide on release rather than silently changing its mode. (Non-routed oversize is only flagged.)
  const routeToOrchestrator =
    scope.oversized && !mode && !input.staged && looksLikeImplementation(`${input.title} ${input.description ?? ""}`);
  if (scope.oversized) {
    if (routeToOrchestrator) mode = "orchestrator";
    if (!tags.includes("too-big")) tags = [...tags, "too-big"];
  }

  // One transaction: validate → insert → cycle-check (+ oversize note). A thrown validation/cycle
  // error (or a crash) ROLLBACKs everything, so a half-created or cyclic row can never reach the board.
  return transaction(() => {
    for (const depId of deps) {
      if (!getTask(depId)) {
        throw new Error(`Cannot create task: dependency #${depId} does not exist`);
      }
    }

    const now = nowIso();
    const status: TaskStatus = input.staged ? "staged" : "pending";
    const info = d
      .prepare(
        `INSERT INTO tasks (title, description, status, priority, tags, mode, depends_on, estimated_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title,
        input.description ?? null,
        status,
        input.priority ?? "medium",
        JSON.stringify(tags),
        mode,
        JSON.stringify(deps),
        estimatedTokens,
        now,
        now,
      );

    const taskId = Number(info.lastInsertRowid);

    // Self-dependency / cycle check; on a cycle the throw rolls the insert back (no manual delete).
    const cycleError = detectCycle(d, taskId, deps);
    if (cycleError) throw new Error(cycleError);

    if (scope.oversized) {
      const routed = routeToOrchestrator
        ? " Routed to orchestrator mode to decompose into subtasks."
        : " Consider splitting it, or set mode 'orchestrator' to decompose it.";
      addNote(
        taskId,
        `⚖ Oversized: estimated ~${estimatedTokens} output tokens > single-dispatch budget ~${scope.budget} ` +
          `(${scope.fileCount} file(s) named).${routed} Tagged 'too-big'.`,
        "scope",
      );
    }

    return getTask(taskId)!;
  });
}

/** Set (or clear) a task's dependencies. Empty array clears all dependencies. */
export function setDependencies(id: number, depends_on: number[]): Task | null {
  const task = getTask(id);
  if (!task) return null;

  const d = getDb();

  // One transaction: the cycle check reads the graph and the UPDATE writes the new edges under the
  // same write lock, so two concurrent setDependencies can't each add an individually-acyclic edge
  // that jointly forms a cycle (and a throw rolls back cleanly).
  return transaction(() => {
    for (const depId of depends_on) {
      if (!getTask(depId)) {
        throw new Error(`Cannot set dependencies: task #${depId} does not exist`);
      }
    }

    const cycleError = detectCycle(d, id, depends_on);
    if (cycleError) throw new Error(cycleError);

    d.prepare("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(depends_on),
      nowIso(),
      id,
    );

    return getTask(id);
  });
}

/** Set (or clear) a task's mode slug. */
export function setMode(id: number, mode: string | null): Task | null {
  if (!getTask(id)) return null;
  getDb().prepare("UPDATE tasks SET mode = ?, updated_at = ? WHERE id = ?").run(mode, nowIso(), id);
  return getTask(id);
}

export function getTask(id: number): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** Hot-path read for await_task's poll loop: just status + result, skipping the full-row parse
 *  (tags / depends_on / mode / …) getTask does. Mirrors questionState's column-narrowing. */
export function getTaskStatus(id: number): { status: TaskStatus; result: string | null } | null {
  const row = getDb().prepare("SELECT status, result FROM tasks WHERE id = ?").get(id) as
    | { status: string; result: string | null }
    | undefined;
  return row ? { status: row.status as TaskStatus, result: (row.result as string | null) ?? null } : null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  tag?: string;
  limit?: number;
}

export function listTasks(opts: ListTasksOptions = {}): Task[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  let sql = "SELECT * FROM tasks";
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY ${PRIORITY_SQL}, created_at ASC`;
  if (opts.limit && !opts.tag) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  let rows = (
    getDb()
      .prepare(sql)
      .all(...(params as any[])) as Record<string, unknown>[]
  ).map(rowToTask);
  if (opts.tag) {
    rows = rows.filter((t) => t.tags.includes(opts.tag!));
    if (opts.limit) rows = rows.slice(0, opts.limit);
  }
  return rows;
}

/** A task narrowed to the fields needed to dedup or glance at the board — no description, result, or
 *  timestamps. board_status returns these inline as open_tasks. */
export interface OpenTaskRow {
  id: number;
  title: string;
  status: TaskStatus;
  mode: string | null;
  tags: string[];
  priority: TaskPriority;
}

/**
 * The live (non-terminal) tasks as compact rows, capped at `cap`. Live = not isFinished:
 * staged / pending / in_progress / needs_input / blocked — the set to dedup a new task against.
 * When more than `cap` are live it keeps the most recently created (the likeliest dedup targets)
 * and sets `truncated` so the caller can fall back to listTasks. Tags are copied, not aliased.
 * Takes an already-loaded task array (board_status loads every task for its counts) so it adds no query.
 */
export function selectOpenTasks(tasks: Task[], cap: number): { open_tasks: OpenTaskRow[]; truncated: boolean } {
  const open = tasks.filter((t) => !isFinished(t.status));
  // listTasks hands us oldest-first; a just-filed near-duplicate (what a dedup scan is hunting) is
  // newest, so when we must drop some, keep the most recently created rather than head-slicing it off.
  const kept =
    open.length > cap ? [...open].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, cap) : open;
  const open_tasks = kept.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    mode: t.mode,
    tags: [...t.tags], // copy so a caller mutating a row can't corrupt the live Task's tags
    priority: t.priority,
  }));
  return { open_tasks, truncated: open.length > cap };
}

// ---------------------------------------------------------------------------
// Board-level dispatch gate (armed/disarmed). When disarmed, NO task is pullable —
// the curator pauses dispatch while bulk-creating/triaging, then re-arms. Default is
// ARMED (no row) so existing boards keep draining; disarm is an explicit opt-in.
// ---------------------------------------------------------------------------
const ARMED_KEY = "armed";

export function isBoardArmed(): boolean {
  const row = getDb().prepare("SELECT value FROM board_state WHERE key = ?").get(ARMED_KEY) as
    | { value?: string }
    | undefined;
  return !row || row.value !== "0";
}

export function setBoardArmed(armed: boolean, reason?: string): void {
  const now = nowIso();
  const upsert = (key: string, value: string) =>
    getDb()
      .prepare(
        `INSERT INTO board_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  upsert(ARMED_KEY, armed ? "1" : "0");
  if (reason !== undefined) upsert("armed_reason", reason);
}

// ---------------------------------------------------------------------------
// Worker heartbeat (liveness). A draining worker upserts a heartbeat on a timer; board_status
// reports whether any is fresh, so a foreman knows await_task will actually be serviced — vs.
// blocking forever because nothing is pulling. A hard-killed worker's stale row ages out of the
// freshness window and is pruned on read.
// ---------------------------------------------------------------------------
/** The worker beats every INTERVAL; a heartbeat counts as live within WINDOW. WINDOW is a
 *  multiple of INTERVAL so a brief GC/IO pause never misreads as "no worker". */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_WINDOW_MS = 20_000;

export interface WorkerLiveness {
  /** A worker beat within the freshness window — the board is being drained. */
  draining: boolean;
  /** Distinct workers that beat within the window. */
  workers: number;
  /** Seconds since the most recent beat, or null if none was ever recorded. */
  last_beat_seconds_ago: number | null;
}

/** A draining worker announces it's alive. Upsert keyed by a stable per-process id; refresh
 *  last_beat each call. `worktree` is the checkout the worker is bound to (its normalized cwd) —
 *  the key the lease (worktreeLeaseHolder) guards so two workers can't bind one checkout. */
export function recordWorkerHeartbeat(
  workerId: string,
  meta: { assignee?: string | null; pid?: number | null; worktree?: string | null } = {},
): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO worker_heartbeats (worker_id, assignee, pid, worktree, started_at, last_beat) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(worker_id) DO UPDATE SET assignee = excluded.assignee, pid = excluded.pid, worktree = excluded.worktree, last_beat = excluded.last_beat`,
    )
    .run(workerId, meta.assignee ?? null, meta.pid ?? null, meta.worktree ?? null, now, now);
}

export interface WorktreeLeaseHolder {
  worker_id: string;
  pid: number | null;
  last_beat_seconds_ago: number;
}

/** The live lease holder for a worktree (a DIFFERENT worker that beat within `windowMs`), or null.
 *  `worktree` is a normalized cwd key; the caller passes its own id to exclude itself. The worker
 *  uses this at startup to refuse a second worker on the same checkout (and may reclaim a holder whose
 *  pid is dead — see clearWorkerHeartbeat). `nowMs` injectable for tests. */
export function worktreeLeaseHolder(
  worktree: string,
  excludeWorkerId: string,
  windowMs = WORKER_HEARTBEAT_WINDOW_MS,
  nowMs = Date.now(),
): WorktreeLeaseHolder | null {
  const row = getDb()
    .prepare(
      "SELECT worker_id, pid, last_beat FROM worker_heartbeats WHERE worktree = ? AND worker_id != ? ORDER BY last_beat DESC LIMIT 1",
    )
    .get(worktree, excludeWorkerId) as { worker_id: string; pid: number | null; last_beat: string } | undefined;
  if (!row) return null;
  const beat = Date.parse(row.last_beat);
  if (!Number.isFinite(beat) || beat < nowMs - windowMs) return null; // unparseable or stale → not a live lease
  return {
    worker_id: row.worker_id,
    pid: row.pid,
    last_beat_seconds_ago: Math.max(0, Math.round((nowMs - beat) / 1000)),
  };
}

export type LeaseClaim = { claimed: true } | { claimed: false; holder: WorktreeLeaseHolder };

/** Atomically claim a worktree's lease: in ONE transaction, check for a live holder and — finding none —
 *  record this worker's heartbeat (the claim). Returns {claimed:false, holder} if another live worker
 *  already owns it. BEGIN IMMEDIATE serializes concurrent claimers, so two workers starting together
 *  can't both observe "no holder" and both proceed (the check-then-claim race). The caller decides
 *  refuse-vs-reclaim on a lost claim (see holderIsLive). */
export function claimWorktreeLease(
  workerId: string,
  meta: { assignee?: string | null; pid?: number | null; worktree: string },
  windowMs = WORKER_HEARTBEAT_WINDOW_MS,
  nowMs = Date.now(),
): LeaseClaim {
  return transaction(() => {
    const holder = worktreeLeaseHolder(meta.worktree, workerId, windowMs, nowMs);
    if (holder) return { claimed: false, holder };
    recordWorkerHeartbeat(workerId, meta);
    return { claimed: true };
  });
}

/** Conservative liveness of a lease holder for the reclaim decision: an unknown (null) pid counts as
 *  ALIVE, so we never reclaim a possibly-live worker's lease — only a pid `isPidAlive` reports dead is
 *  reclaimable. `isPidAlive` is injected (the worker passes a `process.kill(pid, 0)` probe), so this
 *  stays pure and testable. */
export function holderIsLive(pid: number | null, isPidAlive: (pid: number) => boolean): boolean {
  return pid == null ? true : isPidAlive(pid);
}

export interface WorkerLease {
  worktree: string | null;
  worker_id: string;
  pid: number | null;
  last_beat_seconds_ago: number;
}

/** Live worker leases (beat within `windowMs`), most-recent first — surfaced in board_status so a
 *  foreman sees which worktree each worker owns. `nowMs` injectable for tests. */
export function getWorkerLeases(windowMs = WORKER_HEARTBEAT_WINDOW_MS, nowMs = Date.now()): WorkerLease[] {
  const rows = getDb()
    .prepare("SELECT worker_id, pid, worktree, last_beat FROM worker_heartbeats ORDER BY last_beat DESC")
    .all() as { worker_id: string; pid: number | null; worktree: string | null; last_beat: string }[];
  const liveCutoff = nowMs - windowMs;
  return (
    rows
      // Only rows that actually claimed a worktree are leases; a null-worktree beat (pre-T7 / non-worktree
      // worker) shows under worker_draining, not here, so worker_leases is always {worktree:string,…}.
      .filter((r) => r.worktree != null && Date.parse(r.last_beat) >= liveCutoff)
      .map((r) => ({
        worktree: r.worktree,
        worker_id: r.worker_id,
        pid: r.pid,
        last_beat_seconds_ago: Math.max(0, Math.round((nowMs - Date.parse(r.last_beat)) / 1000)),
      }))
  );
}

/** Drop a worker's heartbeat on graceful shutdown (best-effort; the window covers a hard kill). */
export function clearWorkerHeartbeat(workerId: string): void {
  getDb().prepare("DELETE FROM worker_heartbeats WHERE worker_id = ?").run(workerId);
}

/** Is a worker draining the board right now? Live = beat within `windowMs`. Opportunistically
 *  prunes long-dead rows so the table can't grow unbounded. `nowMs` injectable for tests. */
export function getWorkerLiveness(windowMs = WORKER_HEARTBEAT_WINDOW_MS, nowMs = Date.now()): WorkerLiveness {
  getDb()
    .prepare("DELETE FROM worker_heartbeats WHERE last_beat < ?")
    .run(new Date(nowMs - windowMs * 30).toISOString()); // prune workers dead far past the window
  const rows = getDb().prepare("SELECT last_beat FROM worker_heartbeats").all() as { last_beat: string }[];
  const liveCutoff = nowMs - windowMs;
  let workers = 0;
  let mostRecent: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.last_beat);
    if (t >= liveCutoff) workers++;
    if (mostRecent === null || t > mostRecent) mostRecent = t;
  }
  return {
    draining: workers > 0,
    workers,
    last_beat_seconds_ago: mostRecent === null ? null : Math.max(0, Math.round((nowMs - mostRecent) / 1000)),
  };
}

/** Release staged tasks to pending (optionally filtered by ids and/or tag). Returns the count released. */
export function releaseTasks(opts: { ids?: number[]; tag?: string } = {}): number {
  // Empty ids = no filter (release all / by tag), not "release none".
  const ids = opts.ids && opts.ids.length ? new Set(opts.ids) : null;
  let released = 0;
  for (const t of listTasks({ status: "staged" })) {
    if (ids && !ids.has(t.id)) continue;
    if (opts.tag && !t.tags.includes(opts.tag)) continue;
    updateStatus(t.id, "pending");
    released++;
  }
  return released;
}

/** Highest-priority ELIGIBLE pending task (optionally tag-filtered), or null. Returns null while
 *  the board is disarmed so pollers idle instead of pulling mid-curation. Skips tasks whose
 *  dependencies aren't satisfied — eligibility, not just priority — so this MCP/CLI pull path
 *  matches the worker's pickEligible (both gate on blockingDependencies) instead of handing out a
 *  task whose prerequisites aren't done. */
export function nextTask(opts: { tag?: string } = {}): Task | null {
  if (!isBoardArmed()) return null;
  // listTasks is already in pull order (priority, then oldest); return the first eligible one.
  for (const t of listTasks({ status: "pending", tag: opts.tag })) {
    if (!blockingDependencies(t)) return t;
  }
  return null;
}

/**
 * Why a claim would be refused, or null if claimable. Lets callers give a precise
 * message; claimTask itself re-checks atomically.
 */
export function claimBlockReason(id: number): string | null {
  const task = getTask(id);
  if (!task) return `task #${id} not found`;
  if (!isBoardArmed()) return "board is disarmed — dispatch paused; arm the board to claim";
  if (task.status !== CLAIMABLE_STATUS)
    return `task #${id} is '${task.status}', not ${CLAIMABLE_STATUS} — only ${CLAIMABLE_STATUS} tasks can be claimed`;
  const blocking = blockingDependencies(task);
  if (blocking) return `task #${id} is blocked on unfinished dependencies: ${blocking}`;
  return null;
}

/** Claim a task (pending -> in_progress). Refuses staged/non-pending tasks, tasks with unsatisfied
 *  dependencies, and any claim while the board is disarmed: this is the single chokepoint both
 *  drainers pass through, so deps are enforced even for a direct claim (not just the worker's pick). */
export function claimTask(id: number, assignee: string): Task | null {
  const task = getTask(id);
  if (!task) return null;
  if (!isBoardArmed()) return null;
  if (task.status !== CLAIMABLE_STATUS) return null;
  if (blockingDependencies(task)) return null; // deps not satisfied — never claim out of order
  // ATOMIC claim: the `AND status = pending` makes the status flip the single source of truth, so
  // two concurrent claimers (e.g. the worker and an MCP get_next_task(claim)) can't both win — the
  // checks above are only for an early, precise refusal. The winner is whoever's UPDATE changed a row.
  const info = getDb()
    .prepare("UPDATE tasks SET status = 'in_progress', assignee = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(assignee, nowIso(), id, CLAIMABLE_STATUS);
  if (Number(info.changes) === 0) return null; // lost the race — another claimer flipped it first
  return getTask(id);
}

/** IDs of a task's dependencies that aren't satisfied yet (missing, or not isCompleted — so
 *  'analysis_done' counts as done, avoiding the analyze→implement deadlock). The single source of
 *  truth for "what blocks this task", shared by the worker's pickEligible, the claim chokepoint,
 *  and the CLI's blocked-on display. */
export function blockingDependencyIds(task: Task): number[] {
  return task.depends_on.filter((depId) => {
    const dep = getTask(depId);
    return !dep || !isCompleted(dep.status);
  });
}

/** Unsatisfied dependencies as a human-readable `#id[status]` string, or null if all are satisfied. */
export function blockingDependencies(task: Task): string | null {
  const ids = blockingDependencyIds(task);
  if (!ids.length) return null;
  return ids
    .map((id) => {
      const dep = getTask(id);
      return `#${id}[${dep ? dep.status : "missing"}]`;
    })
    .join(", ");
}

/** Count tasks by status, zero-filled for every known status. Shared by board_status / CLI. */
export function countByStatus(tasks: Task[]): Record<TaskStatus, number> {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status]++;
  return counts;
}

export function updateStatus(id: number, status: TaskStatus): Task | null {
  if (!getTask(id)) return null;
  getDb().prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  return getTask(id);
}

/** Write a result, optionally moving to a target status. Shared by setResult/completeTask. */
export function writeResult(id: number, result: string, status?: TaskStatus): void {
  const now = nowIso();
  if (status) {
    getDb()
      .prepare("UPDATE tasks SET result = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(result, status, now, id);
  } else {
    getDb().prepare("UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?").run(result, now, id);
  }
}

export function setResult(id: number, result: string, markDone = true): Task | null {
  if (!getTask(id)) return null;
  writeResult(id, result, markDone ? "done" : undefined);
  return getTask(id);
}

export function addNote(taskId: number, note: string, author?: string): TaskNote | null {
  if (!getTask(taskId)) return null;
  const now = nowIso();
  const info = getDb()
    .prepare("INSERT INTO task_notes (task_id, author, note, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, author ?? null, note, now);
  getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
  return {
    id: Number(info.lastInsertRowid),
    task_id: taskId,
    author: author ?? null,
    note,
    created_at: now,
  };
}

export function getNotes(taskId: number): TaskNote[] {
  return (
    getDb().prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<
      string,
      unknown
    >[]
  ).map(rowToNote);
}

export function deleteTask(id: number): boolean {
  const info = getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return Number(info.changes) > 0;
}

// ---------------------------------------------------------------------------
// Artifact tracking (delete-safety + done-evidence)
// ---------------------------------------------------------------------------
function rowToArtifact(r: Record<string, unknown>): TaskArtifact {
  return {
    id: Number(r.id),
    task_id: Number(r.task_id),
    kind: r.kind as ArtifactKind,
    path: (r.path as string) ?? null,
    detail: (r.detail as string) ?? null,
    created_at: String(r.created_at),
  };
}

export function recordArtifact(
  taskId: number,
  a: { kind: ArtifactKind; path?: string | null; detail?: string | null },
): TaskArtifact | null {
  if (!getTask(taskId)) return null;
  const now = nowIso();
  const info = getDb()
    .prepare("INSERT INTO task_artifacts (task_id, kind, path, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(taskId, a.kind, a.path ?? null, a.detail ?? null, now);
  return {
    id: Number(info.lastInsertRowid),
    task_id: taskId,
    kind: a.kind,
    path: a.path ?? null,
    detail: a.detail ?? null,
    created_at: now,
  };
}

export function getArtifacts(taskId: number): TaskArtifact[] {
  return (
    getDb().prepare("SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<
      string,
      unknown
    >[]
  ).map(rowToArtifact);
}

/** True if the task has execution evidence (excludes read-only 'side-effect' file artifacts). */
export function hasEvidence(taskId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM task_artifacts WHERE task_id = ? AND (detail IS NULL OR detail != 'side-effect')",
    )
    .get(taskId) as { c: number };
  return Number(row.c) > 0;
}

export interface DeleteSafeResult {
  deleted: boolean;
  /** Reason it was refused, or a note about what happened. */
  warning?: string;
  /** Artifacts the (now-or-not) deleted task had recorded. */
  artifacts?: TaskArtifact[];
  /** File paths removed when cleanup was requested. */
  cleaned?: string[];
  /** Recorded paths cleanup REFUSED to unlink because they resolve outside the project root. */
  skipped?: string[];
}

/** True when `p` resolves to `root` itself or a path beneath it (path-traversal guard for unlinks). */
function isUnderRoot(p: string, root: string): boolean {
  const abs = resolve(p);
  return abs === root || abs.startsWith(root + sep);
}

/**
 * Delete a task, but make "delete is not undo" explicit: if the task has
 * recorded artifacts (files written, commits, tests), refuse unless `force`, and with
 * `cleanup` also unlink the orphaned files. Tasks with no side effects delete as before.
 */
export function deleteTaskSafe(
  id: number,
  opts: { force?: boolean; cleanup?: boolean; root?: string } = {},
): DeleteSafeResult {
  const task = getTask(id);
  if (!task) return { deleted: false, warning: `task #${id} not found` };
  const artifacts = getArtifacts(id);

  // Only CREATED files are safe to unlink on cleanup; 'modified' files are live source.
  const created = artifacts.filter((a) => a.kind === "file" && a.path && a.detail === "created");
  const touched = artifacts.filter((a) => a.kind === "file" && a.path);

  if (artifacts.length > 0 && !opts.force && !opts.cleanup) {
    const paths = touched.map((a) => a.path).join(", ");
    const detail = touched.length ? ` Files touched: ${paths}.` : "";
    const cleanupNote = created.length
      ? ` cleanup:true removes the ${created.length} file(s) it created (edited files are left intact).`
      : "";
    return {
      deleted: false,
      artifacts,
      warning:
        `task #${id} has ${artifacts.length} recorded artifact(s); deleting the record will NOT undo them.${detail} ` +
        `Re-run with force:true to delete the record anyway, or cleanup:true to remove created files.${cleanupNote}`,
    };
  }

  // Delete the record FIRST (the cheap, reversible source of truth), THEN unlink files. The reverse
  // order would, on a crash between the two, leave the board pointing at artifacts already gone.
  const deleted = deleteTask(id); // FK ON DELETE CASCADE removes notes + artifacts
  const cleaned: string[] = [];
  const skipped: string[] = [];
  if (deleted && opts.cleanup) {
    // Containment: only unlink files that resolve UNDER the project root — a recorded path that
    // escapes it (a confused/hostile artifact like C:\Windows\… or /etc/…) is refused, never
    // deleted. Defaults to process.cwd() (where the server/CLI runs); callers/tests can override.
    const root = resolve(opts.root ?? process.cwd());
    for (const a of created) {
      if (!isUnderRoot(a.path!, root)) {
        skipped.push(a.path!);
        continue;
      }
      try {
        unlinkSync(a.path!);
        cleaned.push(a.path!);
      } catch {
        /* already gone / not removable */
      }
    }
  }
  return {
    deleted,
    artifacts,
    cleaned: cleaned.length ? cleaned : undefined,
    skipped: skipped.length ? skipped : undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-task checkpoint (pre-task git state for rollback; see src/checkpoint.ts)
// ---------------------------------------------------------------------------
export function setCheckpoint(taskId: number, cp: TaskCheckpoint): void {
  if (!getTask(taskId)) return;
  getDb()
    .prepare("UPDATE tasks SET checkpoint = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cp), nowIso(), taskId);
}

export function getCheckpoint(taskId: number): TaskCheckpoint | null {
  const row = getDb().prepare("SELECT checkpoint FROM tasks WHERE id = ?").get(taskId) as
    | { checkpoint?: string }
    | undefined;
  if (!row?.checkpoint) return null;
  try {
    const cp = JSON.parse(row.checkpoint);
    if (
      cp &&
      typeof cp.root === "string" &&
      typeof cp.ref === "string" &&
      (cp.head === null || typeof cp.head === "string") &&
      Array.isArray(cp.untracked) &&
      // all strings: a non-string would make restore miss a real filename and delete it as task-created
      cp.untracked.every((u: unknown) => typeof u === "string")
    ) {
      return cp as TaskCheckpoint;
    }
  } catch {
    /* malformed */
  }
  return null;
}

/** Drop a task's checkpoint (after it's been consumed by a revert). */
export function clearCheckpoint(taskId: number): void {
  getDb().prepare("UPDATE tasks SET checkpoint = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
}

/** Increment the retry_attempts counter for a task. Returns the updated task. */
export function incrementRetryAttempts(id: number): Task | null {
  if (!getTask(id)) return null;
  // Increment in SQL (not read-modify-write) so concurrent increments can't lose an update and let
  // a task exceed its retry cap.
  getDb()
    .prepare("UPDATE tasks SET retry_attempts = retry_attempts + 1, updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
  return getTask(id);
}

/**
 * Re-queue this assignee's in_progress tasks back to pending — called at worker startup to recover
 * tasks a previous run left claimed when it died mid-dispatch (crash / hard kill), so they aren't
 * stranded in_progress forever. `tag` scopes the reclaim to the worker's own slice (e.g. its
 * `worktree:<name>` pin) so that, on a shared board where several worktree workers run as the same
 * default assignee, one worker's startup can't re-queue another worktree's in-flight task. Returns
 * the number re-queued.
 */
export function reclaimStaleInProgress(assignee: string, tag?: string): number {
  const stale = listTasks({ status: "in_progress", tag }).filter((t) => t.assignee === assignee);
  for (const t of stale) {
    updateStatus(t.id, "pending");
    addNote(
      t.id,
      "Re-queued at worker startup: a prior run left this in_progress (likely a crash mid-dispatch).",
      "worker",
    );
  }
  return stale.length;
}

/** Reset retry_attempts to 0 for a task. Returns the updated task. */
export function resetRetryAttempts(id: number): Task | null {
  if (!getTask(id)) return null;
  getDb().prepare("UPDATE tasks SET retry_attempts = 0, updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getTask(id);
}
