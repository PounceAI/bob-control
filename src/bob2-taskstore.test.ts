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
  isRowSettled,
  bob2DbPath,
  bob2DbExists,
  type Bob2TaskRow,
} from "./bob2-taskstore.js";

const requireModule = createRequire(import.meta.url);

// Bob 2.0 task-store reader against an in-memory db matching the LIVE schema (verified 2026-06-25): id
// and parent_id are TEXT (uuids), created_at/updated_at are INTEGER epoch ms, plus last_error. Correlation
// is snapshot-then-find-the-new-root (id is a uuid, so created_at orders), and the watch settles only on
// a terminal status or last_error. No live Bob needed (the status lifecycle is finished in V7).
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
  row: { id: string; parent?: string | null; status: string; created_at: number; last_error?: string | null },
): void {
  db.prepare(
    "INSERT INTO tasks (id, parent_id, status, directory, created_at, updated_at, costs, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.parent ?? null, row.status, "", row.created_at, row.created_at, null, row.last_error ?? null);
}

test("bob2DbPath resolves ~/.bob/db/bob.db", () => {
  assert.match(bob2DbPath().replace(/\\/g, "/"), /\.bob\/db\/bob\.db$/);
});

test("terminal / settled predicates", () => {
  assert.ok(isTerminal("completed") && isTerminal("error"));
  assert.ok(!isTerminal("active") && !isTerminal("running") && !isTerminal("paused"));
  const row = (status: string, last_error: string | null = null): Bob2TaskRow => ({
    id: "x",
    parent_id: null,
    status,
    directory: "",
    created_at: 1,
    updated_at: 1,
    costs: null,
    last_error,
  });
  assert.ok(isRowSettled(row("completed")) && isRowSettled(row("error")));
  assert.ok(isRowSettled(row("active", "boom"))); // last_error settles even while status is non-terminal
  assert.ok(!isRowSettled(row("active")) && !isRowSettled(row("running"))); // a live turn is NOT settled
});

test("snapshotRoots captures the high-water created_at and the root ids at that timestamp", () => {
  const { db, store } = makeStore();
  insert(db, { id: "a", status: "completed", created_at: 100 });
  insert(db, { id: "b", status: "active", created_at: 200 });
  insert(db, { id: "sub", parent: "b", status: "active", created_at: 300 }); // subtask — not a root
  const snap = store.snapshotRoots();
  assert.equal(snap.sinceMs, 200); // newest ROOT, ignoring the later subtask
  assert.deepEqual([...snap.ids], ["b"]); // only the root at the boundary timestamp
});

test("snapshotRoots on an empty store yields sinceMs 0 and no ids", () => {
  const { store } = makeStore();
  assert.deepEqual(store.snapshotRoots(), { ids: new Set(), sinceMs: 0 });
});

test("newRootSince returns the new root that wasn't in the snapshot, excluding subtasks", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 200 });
  const snap = store.snapshotRoots(); // sinceMs 200, ids {old}
  insert(db, { id: "ours", status: "active", created_at: 250 }); // our dispatch
  insert(db, { id: "kid", parent: "ours", status: "active", created_at: 260 }); // its subtask — excluded
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs)?.id, "ours");
});

test("newRootSince disambiguates a same-millisecond create via the snapshot id-set", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 200 });
  const snap = store.snapshotRoots();
  insert(db, { id: "ours", status: "active", created_at: 200 }); // same ms as the baseline max
  // created_at >= sinceMs would also match 'old', but it's in the snapshot set → 'ours' wins.
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs)?.id, "ours");
});

test("newRootSince returns null when no new root has appeared yet", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 200 });
  const snap = store.snapshotRoots();
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs), null);
});

test("awaitTurnSettled settles on a terminal status", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "t", status: "running", created_at: 1 });
  setTimeout(() => db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 't'").run(), 20);
  const res = await awaitTurnSettled(store, "t", { pollMs: 5, timeoutMs: 2000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.status, "completed");
});

test("awaitTurnSettled settles on a non-null last_error even while status stays non-terminal", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "e", status: "active", created_at: 1 });
  setTimeout(() => db.prepare("UPDATE tasks SET last_error = 'kaboom' WHERE id = 'e'").run(), 20);
  const res = await awaitTurnSettled(store, "e", { pollMs: 5, timeoutMs: 2000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.last_error, "kaboom");
});

test("awaitTurnSettled does NOT settle while the task sits at 'active' (no completion inferred)", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "a", status: "active", created_at: 1 });
  const res = await awaitTurnSettled(store, "a", { pollMs: 5, timeoutMs: 30 });
  assert.equal(res.settled, false); // conservative: a non-terminal state never reads as done
  assert.equal(res.row?.status, "active");
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
