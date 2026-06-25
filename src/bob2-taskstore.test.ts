import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bob2TaskStore,
  awaitTurnSettled,
  isTerminal,
  isActivelyRunning,
  taskError,
  hasRun,
  bob2DbPath,
  bob2DbExists,
  type Bob2TaskRow,
} from "./bob2-taskstore.js";

const requireModule = createRequire(import.meta.url);

// Bob 2.0 task-store reader against an in-memory db matching the LIVE schema (verified 2026-06-25 by
// reading a real dispatched task): id/parent_id TEXT (uuids), created_at/updated_at INTEGER epoch ms,
// last_error (string "null" sentinel on success). Correlation is snapshot-then-find-the-new-root; the
// completion watch follows the live active→running→active lifecycle (settle once not-running + quiet).
function makeStore(): { db: DatabaseSync; store: Bob2TaskStore } {
  const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT, directory TEXT, created_at INTEGER, updated_at INTEGER, costs TEXT, last_error TEXT)",
  );
  return { db, store: new Bob2TaskStore(db) };
}

function insert(
  db: DatabaseSync,
  row: {
    id: string;
    parent?: string | null;
    status: string;
    created_at: number;
    updated_at?: number;
    last_error?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO tasks (id, parent_id, status, directory, created_at, updated_at, costs, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.parent ?? null,
    row.status,
    "",
    row.created_at,
    row.updated_at ?? row.created_at,
    null,
    row.last_error ?? null,
  );
}

const row = (over: Partial<Bob2TaskRow> = {}): Bob2TaskRow => ({
  id: "x",
  parent_id: null,
  status: "active",
  directory: "",
  created_at: 1,
  updated_at: 1,
  costs: null,
  last_error: null,
  ...over,
});

test("bob2DbPath resolves ~/.bob/db/bob.db", () => {
  assert.match(bob2DbPath().replace(/\\/g, "/"), /\.bob\/db\/bob\.db$/);
});

test("status / error / run predicates", () => {
  assert.ok(isActivelyRunning("running") && isActivelyRunning("compacting"));
  assert.ok(!isActivelyRunning("active") && !isActivelyRunning("paused"));
  assert.ok(isTerminal("completed") && isTerminal("error") && !isTerminal("active"));
  // last_error: real value is an error; the "null" / "" sentinels are NOT.
  assert.equal(taskError(row({ last_error: "boom" })), "boom");
  assert.equal(taskError(row({ last_error: "null" })), null); // success sentinel (JSON of null)
  assert.equal(taskError(row({ last_error: "" })), null);
  assert.equal(taskError(row({ last_error: null })), null);
  // hasRun: updated_at advanced past created_at.
  assert.ok(hasRun(row({ created_at: 100, updated_at: 200 })));
  assert.ok(!hasRun(row({ created_at: 100, updated_at: 100 }))); // created, not started
});

test("snapshotRoots captures the high-water created_at and the root ids at that timestamp", () => {
  const { db, store } = makeStore();
  insert(db, { id: "a", status: "completed", created_at: 100 });
  insert(db, { id: "b", status: "active", created_at: 200 });
  insert(db, { id: "sub", parent: "b", status: "active", created_at: 300 }); // subtask — not a root
  const snap = store.snapshotRoots();
  assert.equal(snap.sinceMs, 200);
  assert.deepEqual([...snap.ids], ["b"]);
});

test("snapshotRoots on an empty store yields sinceMs 0 and no ids", () => {
  const { store } = makeStore();
  assert.deepEqual(store.snapshotRoots(), { ids: new Set(), sinceMs: 0 });
});

test("newRootSince returns the new root that wasn't in the snapshot, excluding subtasks", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 200 });
  const snap = store.snapshotRoots();
  insert(db, { id: "ours", status: "active", created_at: 250 });
  insert(db, { id: "kid", parent: "ours", status: "active", created_at: 260 });
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs)?.id, "ours");
});

test("newRootSince disambiguates a same-millisecond create via the snapshot id-set", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 200 });
  const snap = store.snapshotRoots();
  insert(db, { id: "ours", status: "active", created_at: 200 }); // same ms as the baseline max
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs)?.id, "ours");
});

test("newRootSince returns null when no new root has appeared yet", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 200 });
  const snap = store.snapshotRoots();
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs), null);
});

// ── completion watch (live active→running→active lifecycle) ───────────────────────────────────────

test("awaitTurnSettled does NOT settle while the task is 'running', even with stale updated_at", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "r", status: "running", created_at: Date.now() - 10_000, updated_at: Date.now() - 9_000 });
  const res = await awaitTurnSettled(store, "r", { pollMs: 5, quietMs: 20, timeoutMs: 40 });
  assert.equal(res.settled, false); // running gates the settle regardless of the updated_at gap
  assert.equal(res.row?.status, "running");
});

test("awaitTurnSettled does NOT settle a created-but-unstarted row (updated_at == created_at)", async () => {
  const { db, store } = makeStore();
  const t = Date.now() - 10_000;
  insert(db, { id: "c", status: "active", created_at: t, updated_at: t }); // hasRun false
  const res = await awaitTurnSettled(store, "c", { pollMs: 5, quietMs: 20, timeoutMs: 40 });
  assert.equal(res.settled, false);
});

test("awaitTurnSettled settles once the row leaves 'running' and goes quiet", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "t", status: "running", created_at: Date.now() - 1_000, updated_at: Date.now() });
  setTimeout(() => db.prepare("UPDATE tasks SET status='active', updated_at=? WHERE id='t'").run(Date.now()), 15);
  const res = await awaitTurnSettled(store, "t", { pollMs: 5, quietMs: 25, timeoutMs: 2_000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.status, "active"); // back to active + quiet = done
});

test("awaitTurnSettled settles immediately on a real last_error", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "e", status: "running", created_at: Date.now() - 1_000, updated_at: Date.now() });
  setTimeout(() => db.prepare("UPDATE tasks SET last_error='kaboom' WHERE id='e'").run(), 15);
  const res = await awaitTurnSettled(store, "e", { pollMs: 5, quietMs: 5_000, timeoutMs: 2_000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.last_error, "kaboom");
});

test("open() throws a clear error when the db file is absent", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "bob2db-")), "nope.db");
  assert.throws(() => Bob2TaskStore.open(missing), /not found/);
});

test("bob2DbExists reports whether the store file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob2db-"));
  try {
    assert.equal(bob2DbExists(join(dir, "absent.db")), false);
    const present = join(dir, "present.db");
    writeFileSync(present, "");
    assert.equal(bob2DbExists(present), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
