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
  isActivelyRunning,
  isTerminal,
  bob2DbPath,
  bob2DbExists,
} from "./bob2-taskstore.js";

const requireModule = createRequire(import.meta.url);

// Bob 2.0 task-store reader: correlation (newest ROOT task in a directory after a baseline id),
// the running/terminal predicates, and the poll-to-settled loop. Runs against an in-memory db with
// the documented tasks columns — no live Bob needed (the live schema is verified in V7).
function makeStore(): { db: DatabaseSync; store: Bob2TaskStore } {
  const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks (id INTEGER PRIMARY KEY, parent_id INTEGER, status TEXT, directory TEXT, updated_at TEXT, costs TEXT)",
  );
  return { db, store: new Bob2TaskStore(db) };
}

function insert(db: DatabaseSync, id: number, parent: number | null, status: string, dir: string): void {
  db.prepare("INSERT INTO tasks (id, parent_id, status, directory, updated_at, costs) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    parent,
    status,
    dir,
    "2026-06-25T00:00:00Z",
    null,
  );
}

test("bob2DbPath resolves ~/.bob/db/bob.db", () => {
  assert.match(bob2DbPath().replace(/\\/g, "/"), /\.bob\/db\/bob\.db$/);
});

test("running/terminal predicates classify the status enum", () => {
  assert.ok(isActivelyRunning("running") && isActivelyRunning("compacting"));
  assert.ok(!isActivelyRunning("active") && !isActivelyRunning("completed"));
  assert.ok(isTerminal("completed") && isTerminal("error"));
  assert.ok(!isTerminal("active") && !isTerminal("running"));
});

test("maxIdInDir returns the directory's high-water id, 0 for an unseen directory", () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "completed", "C:/wt/a");
  insert(db, 2, null, "running", "C:/wt/a");
  insert(db, 3, 2, "running", "C:/wt/a"); // subtask
  insert(db, 4, null, "running", "C:/wt/b");
  assert.equal(store.maxIdInDir("C:/wt/a"), 3);
  assert.equal(store.maxIdInDir("C:/wt/c"), 0);
});

test("newRootTaskSince correlates the newest ROOT task created after the baseline, scoped to the directory", () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "completed", "C:/wt/a"); // pre-baseline
  insert(db, 2, null, "running", "C:/wt/a"); // our new root
  insert(db, 3, 2, "running", "C:/wt/a"); // subtask of 2 — must be excluded
  insert(db, 4, null, "running", "C:/wt/b"); // other directory

  assert.equal(store.newRootTaskSince("C:/wt/a", 1)?.id, 2); // newest root, id>1, parent NULL
  assert.equal(store.newRootTaskSince("C:/wt/a", 2), null); // only the subtask is newer → none
  assert.equal(store.newRootTaskSince("C:/wt/b", 0)?.id, 4); // other dir resolves independently
});

test("awaitTurnSettled returns immediately when the task is already settled", async () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "completed", "C:/wt/a");
  const res = await awaitTurnSettled(store, 1, { pollMs: 5, timeoutMs: 1000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.status, "completed");
});

test("awaitTurnSettled times out (settled:false) while the task stays running", async () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "running", "C:/wt/a");
  const res = await awaitTurnSettled(store, 1, { pollMs: 5, timeoutMs: 30 });
  assert.equal(res.settled, false);
  assert.equal(res.row?.status, "running");
});

test("awaitTurnSettled resolves once the status transitions out of running", async () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "running", "C:/wt/a");
  setTimeout(() => db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 1").run(), 20);
  const res = await awaitTurnSettled(store, 1, { pollMs: 5, timeoutMs: 2000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.status, "completed");
});

test("awaitTurnSettled does NOT settle on the initial 'active' state before the task starts running", async () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "active", "C:/wt/a"); // created but not yet running
  const res = await awaitTurnSettled(store, 1, { pollMs: 5, timeoutMs: 30 });
  assert.equal(res.settled, false); // a naive "not running ⇒ done" would have false-completed here
  assert.equal(res.row?.status, "active");
});

test("awaitTurnSettled settles once the turn goes idle ('active') after running", async () => {
  const { db, store } = makeStore();
  insert(db, 1, null, "running", "C:/wt/a");
  setTimeout(() => db.prepare("UPDATE tasks SET status = 'active' WHERE id = 1").run(), 20);
  const res = await awaitTurnSettled(store, 1, { pollMs: 5, timeoutMs: 2000 });
  assert.equal(res.settled, true); // saw running, then it went idle → the turn is done
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
