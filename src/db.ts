import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  Task,
  TaskNote,
  TaskStatus,
  TaskPriority,
  TaskArtifact,
  ArtifactKind,
  TaskQuestion,
  QuestionState,
  TaskCheckpoint,
} from "./types.js";
import { CLAIMABLE_STATUS, isCompleted, TASK_STATUSES } from "./types.js";

/** Default time a board question waits for a human answer before the worker parks blocked. */
const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
/** Upper bound so `now + timeoutMs` can't overflow the max Date (toISOString would throw). */
const MAX_QUESTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Required lazily in getDb so the warning suppressor runs before node:sqlite loads.
const requireModule = createRequire(import.meta.url);

const moduleDir = dirname(fileURLToPath(import.meta.url));

// SQLite path resolution, in order:
//   1. BOB_TASKS_DB         — explicit path wins.
//   2. BOB_TASKS_PORTABLE   — a shared board in the user's home (~/.bob-tasks/tasks.db),
//      so the Claude Code plugin and Bob can agree on one queue from any repo.
//   3. else                 — the repo-local <project-root>/data/tasks.db.
export function defaultDbPath(): string {
  if (process.env.BOB_TASKS_DB) return resolve(process.env.BOB_TASKS_DB);
  if (process.env.BOB_TASKS_PORTABLE) return resolve(homedir(), ".bob-tasks", "tasks.db");
  return resolve(moduleDir, "..", "data", "tasks.db");
}

let db: DatabaseSync | null = null;

// Singleton SQLite handle. `path` is only honored on the first call; later
// calls ignore it and return the existing handle.
export function getDb(path = defaultDbPath()): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  // The board is per-project state, never source: keep it out of the consuming repo's
  // git status so it can't land as untracked tasks.db* at a repo root (incident D).
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
function transaction<T>(fn: () => T): T {
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
  `);

  // node:sqlite has no "ADD COLUMN IF NOT EXISTS", so probe and add what's missing.
  addColumnIfMissing(d, "tasks", "mode", "TEXT");
  addColumnIfMissing(d, "tasks", "depends_on", "TEXT");
  addColumnIfMissing(d, "tasks", "retry_attempts", "INTEGER DEFAULT 0");
  addColumnIfMissing(d, "tasks", "checkpoint", "TEXT");
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

function nowIso(): string {
  return new Date().toISOString();
}

// Tags are a JSON array string; tolerate malformed/legacy values instead of throwing.
function parseTags(raw: unknown): string[] {
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
}

export function createTask(input: CreateTaskInput): Task {
  const d = getDb();
  const deps = input.depends_on ?? [];

  // One transaction: validate → insert → cycle-check. A thrown validation/cycle error (or a crash)
  // ROLLBACKs the insert, so a half-created or cyclic row can never reach the board.
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
        `INSERT INTO tasks (title, description, status, priority, tags, mode, depends_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title,
        input.description ?? null,
        status,
        input.priority ?? "medium",
        JSON.stringify(input.tags ?? []),
        input.mode ?? null,
        JSON.stringify(deps),
        now,
        now,
      );

    const taskId = Number(info.lastInsertRowid);

    // Self-dependency / cycle check; on a cycle the throw rolls the insert back (no manual delete).
    const cycleError = detectCycle(d, taskId, deps);
    if (cycleError) throw new Error(cycleError);

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

/** Unsatisfied dependencies (not yet isCompleted), or null if all are. Shared by the worker
 *  and CLI so analysis_done deps don't deadlock the analyze→implement pattern. */
export function blockingDependencies(task: Task): string | null {
  if (!task.depends_on.length) return null;
  const blocking: string[] = [];
  for (const depId of task.depends_on) {
    const dep = getTask(depId);
    if (!dep) blocking.push(`#${depId}[missing]`);
    else if (!isCompleted(dep.status)) blocking.push(`#${depId}[${dep.status}]`);
  }
  return blocking.length ? blocking.join(", ") : null;
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
function writeResult(id: number, result: string, status?: TaskStatus): void {
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

/** Evidence that a task actually executed (vs. produced only analysis). */
export interface Evidence {
  /** Number of files changed (0 = no code written). */
  files_changed?: number;
  /** Paths changed — recorded as 'file' artifacts (absolute where possible, for cleanup). */
  files?: string[];
  /** Commit sha produced by the run. */
  commit?: string;
  /** Verification summary, e.g. "vitest: 42 passed". */
  test?: string;
  /** Human-readable diffstat. */
  diffstat?: string;
}

function evidenceHasChanges(e?: Evidence): boolean {
  if (!e) return false;
  return Boolean(
    (e.files_changed && e.files_changed > 0) ||
    (e.files && e.files.length > 0) ||
    (e.commit && e.commit.trim()) ||
    (e.test && e.test.trim()),
  );
}

function recordEvidenceArtifacts(taskId: number, e: Evidence): void {
  for (const f of e.files ?? []) recordArtifact(taskId, { kind: "file", path: f });
  if (e.commit && e.commit.trim()) recordArtifact(taskId, { kind: "commit", detail: e.commit.trim() });
  if (e.test && e.test.trim()) recordArtifact(taskId, { kind: "test", detail: e.test.trim() });
  // diffstat-only evidence stays a caller note, not a pathless 'file' artifact (would block delete).
}

export interface CompleteOptions {
  result: string;
  /** True when the resolved mode was read-only (ask/plan/review): never reaches done. */
  ranReadOnly: boolean;
  evidence?: Evidence;
  /** False when changes couldn't be checked (cwd not a git repo): impl-with-no-evidence is
   *  then marked done-UNVERIFIED, not demoted to analysis_done. Default true. */
  evidenceReliable?: boolean;
}

/**
 * Gated completion (worker + submit_result): read-only → analysis_done; impl+evidence → done;
 * impl+no-evidence → analysis_done, or done-UNVERIFIED when evidence wasn't checkable.
 */
export function completeTask(id: number, opts: CompleteOptions): Task | null {
  const task = getTask(id);
  if (!task) return null;
  if (opts.evidence) recordEvidenceArtifacts(id, opts.evidence);

  // Read-only is a mode fact, reliable regardless of cwd.
  if (opts.ranReadOnly) {
    writeResult(id, opts.result, "analysis_done");
    return getTask(id);
  }

  const hasEv = evidenceHasChanges(opts.evidence) || hasEvidence(id);
  if (hasEv) {
    writeResult(id, opts.result, "done");
    return getTask(id);
  }
  if (opts.evidenceReliable === false) {
    // Couldn't verify changes — trust the completion, flag it, don't mismark as analysis_done.
    writeResult(id, opts.result, "done");
    addNote(
      id,
      "Completed; execution evidence could not be captured (working dir is not a git repo, or not the workspace that was edited) — marked done UNVERIFIED.",
      "worker",
    );
    return getTask(id);
  }
  writeResult(id, opts.result, "analysis_done");
  addNote(
    id,
    "Completed without execution evidence (no diff/commit/test recorded) — left as analysis_done; needs implementation/verification.",
    "worker",
  );
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
}

/**
 * Delete a task, but make "delete is not undo" explicit (incident B): if the task has
 * recorded artifacts (files written, commits, tests), refuse unless `force`, and with
 * `cleanup` also unlink the orphaned files. Tasks with no side effects delete as before.
 */
export function deleteTaskSafe(id: number, opts: { force?: boolean; cleanup?: boolean } = {}): DeleteSafeResult {
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
  if (deleted && opts.cleanup) {
    for (const a of created) {
      try {
        unlinkSync(a.path!);
        cleaned.push(a.path!);
      } catch {
        /* already gone / not removable */
      }
    }
  }
  return { deleted, artifacts, cleaned: cleaned.length ? cleaned : undefined };
}

// ---------------------------------------------------------------------------
// Human-input questions (the board-native ask/answer round-trip)
// ---------------------------------------------------------------------------
function rowToQuestion(r: Record<string, unknown>): TaskQuestion {
  return {
    question_id: String(r.question_id),
    task_id: Number(r.task_id),
    text: String(r.text),
    options: parseTags(r.options), // reuse the tolerant JSON-array parser
    status: r.status as QuestionState,
    answer: (r.answer as string) ?? null,
    asked_at: String(r.asked_at),
    answered_at: (r.answered_at as string) ?? null,
    deadline_at: String(r.deadline_at),
  };
}

/**
 * Raise a question on the board: park the task `needs_input`, persist the question, and
 * add a human-readable note. The worker then polls questionState by question_id. Returns
 * the created question (with its generated question_id).
 */
export function askQuestion(
  taskId: number,
  text: string,
  options: string[] = [],
  timeoutMs: number = DEFAULT_QUESTION_TIMEOUT_MS,
): TaskQuestion | null {
  const task = getTask(taskId);
  if (!task) return null;
  // Only a task actively being worked can raise a question — prevents a stale/duplicate ask
  // from resurrecting a finished/unclaimed task into needs_input. (needs_input allows a re-ask.)
  if (task.status !== "in_progress" && task.status !== "needs_input") return null;
  const now = Date.now();
  const asked = nowIso();
  const deadline = new Date(now + Math.min(timeoutMs, MAX_QUESTION_TIMEOUT_MS)).toISOString();
  const id = randomUUID();
  // One transaction for the whole ask: supersede the prior open question, insert the new one, park
  // the task needs_input, and log — so a crash mid-sequence can never strand the task needs_input
  // with no open question to answer (an unrecoverable wedge).
  return transaction(() => {
    // One open question per task: supersede any prior open one so the answer/timeout correlation
    // by question_id is unambiguous (getOpenQuestion can't shadow a second open row).
    getDb().prepare("UPDATE task_questions SET status = 'timed_out' WHERE task_id = ? AND status = 'open'").run(taskId);
    getDb()
      .prepare(
        `INSERT INTO task_questions (question_id, task_id, text, options, status, asked_at, deadline_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, taskId, text, JSON.stringify(options), asked, deadline);
    updateStatus(taskId, "needs_input");
    const optStr = options.length ? `\nOptions: ${options.join(" | ")}` : "";
    addNote(taskId, `❓ Awaiting answer [${id}]: ${text}${optStr}`, "worker");
    return getQuestion(id);
  });
}

export function getQuestion(questionId: string): TaskQuestion | null {
  const row = getDb().prepare("SELECT * FROM task_questions WHERE question_id = ?").get(questionId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToQuestion(row) : null;
}

/** The task's current open question, or null. (askQuestion keeps at most one open per task;
 *  rowid breaks any asked_at tie deterministically.) Powers get_task. */
export function getOpenQuestion(taskId: number): TaskQuestion | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM task_questions WHERE task_id = ? AND status = 'open' ORDER BY asked_at DESC, rowid DESC LIMIT 1",
    )
    .get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToQuestion(row) : null;
}

/** All open questions across the board (for `bob questions`). */
export function listOpenQuestions(): TaskQuestion[] {
  return (
    getDb().prepare("SELECT * FROM task_questions WHERE status = 'open' ORDER BY asked_at ASC").all() as Record<
      string,
      unknown
    >[]
  ).map(rowToQuestion);
}

export type AnswerResult = { ok: true; alreadyAnswered: boolean } | { ok: false; error: string };

/**
 * Answer a question, matched by its unique question_id (so a stale answer can't apply to a
 * different/new question). Records the answer, clears the open state, and resumes the task
 * (needs_input -> in_progress) so the waiting worker continues. Idempotent on an already
 * answered question; rejects unknown / wrong-task / timed-out ids.
 */
export function answerQuestion(taskId: number, questionId: string, answer: string): AnswerResult {
  const q = getQuestion(questionId);
  if (!q || q.task_id !== taskId) {
    return { ok: false, error: `no question '${questionId}' on task #${taskId}` };
  }
  if (q.status === "answered") return { ok: true, alreadyAnswered: true }; // idempotent
  if (q.status === "timed_out") {
    return { ok: false, error: `question '${questionId}' timed out; re-ask before answering` };
  }
  // Conditional on still-open so a concurrent timeout (another process) can't be clobbered:
  // exactly one of answer/timeout wins (SQLite serializes the writes). changes===0 => lost.
  const info = getDb()
    .prepare(
      "UPDATE task_questions SET status = 'answered', answer = ?, answered_at = ? WHERE question_id = ? AND status = 'open'",
    )
    .run(answer, nowIso(), questionId);
  if (Number(info.changes) === 0) {
    const fresh = getQuestion(questionId);
    if (fresh?.status === "answered") return { ok: true, alreadyAnswered: true };
    return { ok: false, error: `question '${questionId}' is now '${fresh?.status ?? "gone"}' — cannot answer` };
  }
  // Resume the waiting worker (only if still parked on this question).
  if (getTask(taskId)?.status === "needs_input") updateStatus(taskId, "in_progress");
  addNote(taskId, `✅ Answered [${questionId}]: ${answer}`, "human");
  return { ok: true, alreadyAnswered: false };
}

/**
 * Poll state for await_answer. Reads only the columns the poll needs (no options parse on the
 * hot path). If the question is open but past its deadline, time it out and park the task
 * `blocked` (fail-safe: never fabricate an answer) — conditional on still-open so it can't
 * clobber a concurrent answer. `nowMs` injectable for tests.
 */
export function questionState(
  questionId: string,
  nowMs: number = Date.now(),
): { status: QuestionState | "unknown"; answer?: string } {
  const row = getDb()
    .prepare("SELECT task_id, status, answer, deadline_at FROM task_questions WHERE question_id = ?")
    .get(questionId) as
    | { task_id: number; status: QuestionState; answer: string | null; deadline_at: string }
    | undefined;
  if (!row) return { status: "unknown" };
  if (row.status === "answered") return { status: "answered", answer: row.answer ?? "" };
  if (row.status === "open" && nowMs > Date.parse(row.deadline_at)) {
    const info = getDb()
      .prepare("UPDATE task_questions SET status = 'timed_out' WHERE question_id = ? AND status = 'open'")
      .run(questionId);
    if (Number(info.changes) === 0) {
      // Lost the race to an answer — report the real outcome, don't park blocked.
      const fresh = getQuestion(questionId);
      return fresh?.status === "answered"
        ? { status: "answered", answer: fresh.answer ?? "" }
        : { status: (fresh?.status as QuestionState) ?? "unknown" };
    }
    if (getTask(Number(row.task_id))?.status === "needs_input") updateStatus(Number(row.task_id), "blocked");
    addNote(
      Number(row.task_id),
      `⏰ Question [${questionId}] unanswered past timeout — parked blocked (no answer fabricated).`,
      "worker",
    );
    return { status: "timed_out" };
  }
  return { status: row.status };
}

/**
 * Sweep: time out every open question past its deadline (parking its task blocked), so the
 * fail-safe fires even if the worker that asked never polls again (it died / stopped looping).
 * Call from board activity (board_status / get_next_task) and the worker loop. Returns the count.
 */
export function expireOverdueQuestions(nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs).toISOString();
  const overdue = getDb()
    .prepare("SELECT question_id FROM task_questions WHERE status = 'open' AND deadline_at < ?")
    .all(cutoff) as { question_id: string }[];
  let n = 0;
  for (const r of overdue) {
    if (questionState(r.question_id, nowMs).status === "timed_out") n++;
  }
  return n;
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
 * stranded in_progress forever. Assumes a single worker per assignee (the design — one IPC pipe
 * dispatches serially). Returns the number re-queued.
 */
export function reclaimStaleInProgress(assignee: string): number {
  const stale = listTasks({ status: "in_progress" }).filter((t) => t.assignee === assignee);
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
