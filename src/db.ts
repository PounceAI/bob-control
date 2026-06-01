import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task, TaskNote, TaskStatus, TaskPriority } from "./types.js";

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
  `);

  // node:sqlite has no "ADD COLUMN IF NOT EXISTS", so probe and add what's missing.
  addColumnIfMissing(d, "tasks", "mode", "TEXT");
  addColumnIfMissing(d, "tasks", "depends_on", "TEXT");
}

function addColumnIfMissing(
  d: DatabaseSync,
  table: string,
  column: string,
  type: string,
): void {
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
const PRIORITY_SQL =
  "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  tags?: string[];
  /** Bob mode slug, or null/undefined to let the dispatcher auto-route. */
  mode?: string | null;
  /** Task IDs this task depends on. */
  depends_on?: number[];
}

export function createTask(input: CreateTaskInput): Task {
  const d = getDb();
  const deps = input.depends_on ?? [];

  // Validate dependencies and check for cycles
  for (const depId of deps) {
    if (!getTask(depId)) {
      throw new Error(`Cannot create task: dependency #${depId} does not exist`);
    }
  }

  const now = nowIso();
  const info = d
    .prepare(
      `INSERT INTO tasks (title, description, status, priority, tags, mode, depends_on, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.description ?? null,
      input.priority ?? "medium",
      JSON.stringify(input.tags ?? []),
      input.mode ?? null,
      JSON.stringify(deps),
      now,
      now,
    );

  const taskId = Number(info.lastInsertRowid);

  // Check for cycles after creation (self-dependency is caught here)
  const cycleError = detectCycle(d, taskId, deps);
  if (cycleError) {
    // Rollback by deleting the task
    d.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    throw new Error(cycleError);
  }

  return getTask(taskId)!;
}

/** Set (or clear) a task's dependencies. Empty array clears all dependencies. */
export function setDependencies(id: number, depends_on: number[]): Task | null {
  const task = getTask(id);
  if (!task) return null;

  const d = getDb();

  // Validate dependencies exist
  for (const depId of depends_on) {
    if (!getTask(depId)) {
      throw new Error(`Cannot set dependencies: task #${depId} does not exist`);
    }
  }

  // Check for cycles before committing
  const cycleError = detectCycle(d, id, depends_on);
  if (cycleError) {
    throw new Error(cycleError);
  }

  d.prepare("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(depends_on), nowIso(), id);

  return getTask(id);
}

/** Set (or clear) a task's mode slug. */
export function setMode(id: number, mode: string | null): Task | null {
  if (!getTask(id)) return null;
  getDb()
    .prepare("UPDATE tasks SET mode = ?, updated_at = ? WHERE id = ?")
    .run(mode, nowIso(), id);
  return getTask(id);
}

export function getTask(id: number): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
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
  let rows = (getDb().prepare(sql).all(...(params as any[])) as Record<string, unknown>[]).map(
    rowToTask,
  );
  if (opts.tag) {
    rows = rows.filter((t) => t.tags.includes(opts.tag!));
    if (opts.limit) rows = rows.slice(0, opts.limit);
  }
  return rows;
}

/** Highest-priority pending task (optionally tag-filtered), or null. */
export function nextTask(opts: { tag?: string } = {}): Task | null {
  const tasks = listTasks({ status: "pending", tag: opts.tag, limit: 1 });
  return tasks[0] ?? null;
}

export function claimTask(id: number, assignee: string): Task | null {
  if (!getTask(id)) return null;
  getDb()
    .prepare("UPDATE tasks SET status = 'in_progress', assignee = ?, updated_at = ? WHERE id = ?")
    .run(assignee, nowIso(), id);
  return getTask(id);
}

export function updateStatus(id: number, status: TaskStatus): Task | null {
  if (!getTask(id)) return null;
  getDb()
    .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso(), id);
  return getTask(id);
}

export function setResult(id: number, result: string, markDone = true): Task | null {
  if (!getTask(id)) return null;
  const now = nowIso();
  if (markDone) {
    getDb()
      .prepare("UPDATE tasks SET result = ?, status = 'done', updated_at = ? WHERE id = ?")
      .run(result, now, id);
  } else {
    getDb()
      .prepare("UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?")
      .run(result, now, id);
  }
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
    getDb()
      .prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Record<string, unknown>[]
  ).map(rowToNote);
}

export function deleteTask(id: number): boolean {
  const info = getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return Number(info.changes) > 0;
}
