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
  parseCosts,
  firstMessageMatches,
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
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT, directory TEXT, created_at INTEGER, updated_at INTEGER, costs TEXT, last_error TEXT, first_message TEXT, env TEXT)",
  );
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, data TEXT, created_at INTEGER)");
  return { db, store: new Bob2TaskStore(db) };
}

let msgSeq = 0;
function insertMessage(db: DatabaseSync, taskId: string, role: string, data: unknown, createdAt: number): void {
  db.prepare("INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?, ?, ?, ?, ?)").run(
    `m${++msgSeq}`,
    taskId,
    role,
    JSON.stringify(data),
    createdAt,
  );
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
    first_message?: string;
    env?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO tasks (id, parent_id, status, directory, created_at, updated_at, costs, last_error, first_message, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.parent ?? null,
    row.status,
    "",
    row.created_at,
    row.updated_at ?? row.created_at,
    null,
    row.last_error ?? null,
    row.first_message ?? null,
    row.env ?? null,
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

// ── multi-window correlation (Tier 3): two Bob windows share the one global bob.db ──────────────────

test("newRootSince: a lone new root is ours even if content doesn't match (startTask already created it)", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 100 });
  const snap = store.snapshotRoots();
  insert(db, { id: "ours", status: "active", created_at: 200, first_message: "Task #5: do X" });
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs, "Task #5: do X")?.id, "ours");
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs, "totally different")?.id, "ours"); // lone → ours
});

test("newRootSince: with a concurrent window's competing new root, content picks OURS — not newest", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: 100 });
  const snap = store.snapshotRoots();
  insert(db, { id: "ours", status: "active", created_at: 250, first_message: "Task #5: our job" });
  insert(db, { id: "theirs", status: "active", created_at: 300, first_message: "Task #9: their job" }); // newer
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs, "Task #5: our job")?.id, "ours"); // content wins
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs)?.id, "theirs"); // legacy newest-wins = the old race
  assert.equal(store.newRootSince(snap.ids, snap.sinceMs, "no match yet"), null); // 2+ & no match → keep polling
});

test("firstMessageMatches tolerates reformatting (prefix/containment), rejects mismatch/empty", () => {
  assert.ok(firstMessageMatches("Task #5: build the widget", "Task #5: build the widget")); // exact
  assert.ok(firstMessageMatches("Task #5:  build the   widget", "Task #5: build the widget")); // whitespace
  assert.ok(firstMessageMatches("[mask] Task #5: build the widget now", "Task #5: build the widget")); // contained
  assert.ok(!firstMessageMatches("Task #9: something else", "Task #5: build the widget"));
  assert.ok(!firstMessageMatches(null, "x") && !firstMessageMatches("x", ""));
});

// ── defer-while-chatting: foreignActivity (2.0 bob.db poll, workspace-scoped, time-bounded) ─────────

const WS = "c:\\proj\\bob-control";
const envJson = (ws: string) => JSON.stringify({ id: "x", workspace: ws, scheme: "file" });
// Fixed virtual clock so the time-bounds are deterministic (no real Date.now()): idle window = last 60s,
// running staleness clamp = last 300s.
const NOW = 1_000_000;
const cut = (over: Partial<{ activeSinceMs: number; runningSinceMs: number }> = {}) => ({
  activeSinceMs: NOW - 60_000,
  runningSinceMs: NOW - 300_000,
  ...over,
});

test("foreignActivity: a foreign running root in our workspace ⇒ running + activeRecently", () => {
  const { db, store } = makeStore();
  insert(db, { id: "chat", status: "running", created_at: NOW - 5_000, updated_at: NOW - 1_000, env: envJson(WS) });
  assert.deepEqual(store.foreignActivity(new Set(), WS, cut()), { running: true, activeRecently: true });
});

test("foreignActivity: our OWN root is excluded from BOTH signals even though it is recent+running", () => {
  const { db, store } = makeStore();
  insert(db, { id: "ours", status: "running", created_at: NOW - 5_000, updated_at: NOW - 1_000, env: envJson(WS) });
  // Proven against a PRESENT recent running row: if ownIds were applied to only one signal, the other trips.
  assert.deepEqual(store.foreignActivity(new Set(["ours"]), WS, cut()), { running: false, activeRecently: false });
});

test("foreignActivity: a running root in ANOTHER workspace does not count (bob.db is global)", () => {
  const { db, store } = makeStore();
  insert(db, {
    id: "x",
    status: "running",
    created_at: NOW - 5_000,
    updated_at: NOW - 1_000,
    env: envJson("c:\\proj\\elsewhere"),
  });
  assert.deepEqual(store.foreignActivity(new Set(), WS, cut()), { running: false, activeRecently: false });
});

test("foreignActivity: workspace match reuses sameWorkspace (case / separator / '.' insensitive)", () => {
  const { db, store } = makeStore();
  insert(db, {
    id: "chat",
    status: "running",
    created_at: NOW - 5_000,
    updated_at: NOW - 1_000,
    env: envJson("C:/Proj/./Bob-Control/"),
  });
  assert.equal(store.foreignActivity(new Set(), WS, cut()).running, true);
});

test("foreignActivity: a just-finished foreign root within the idle window ⇒ activeRecently (grace)", () => {
  const { db, store } = makeStore();
  insert(db, { id: "done", status: "active", created_at: NOW - 50_000, updated_at: NOW - 30_000, env: envJson(WS) });
  assert.deepEqual(store.foreignActivity(new Set(), WS, cut()), { running: false, activeRecently: true });
});

test("foreignActivity: a foreign root older than the idle window ⇒ nothing", () => {
  const { db, store } = makeStore();
  insert(db, { id: "old", status: "active", created_at: NOW - 200_000, updated_at: NOW - 120_000, env: envJson(WS) });
  assert.deepEqual(store.foreignActivity(new Set(), WS, cut()), { running: false, activeRecently: false });
});

test("foreignActivity: idle window is inclusive at the cutoff (>=), exclusive just past it", () => {
  const { db, store } = makeStore();
  insert(db, { id: "edge", status: "active", created_at: NOW - 60_000, updated_at: NOW - 60_000, env: envJson(WS) });
  assert.equal(store.foreignActivity(new Set(), WS, cut()).activeRecently, true); // updated_at == activeSinceMs
  assert.equal(store.foreignActivity(new Set(), WS, cut({ activeSinceMs: NOW - 59_999 })).activeRecently, false);
});

test("foreignActivity: a stuck 'running' root older than the staleness clamp self-heals (not running)", () => {
  const { db, store } = makeStore();
  // A crashed window left it 'running' but updated_at is 6 min old (> runningSinceMs) → must not wedge defer.
  insert(db, {
    id: "stuck",
    status: "running",
    created_at: NOW - 400_000,
    updated_at: NOW - 360_000,
    env: envJson(WS),
  });
  assert.deepEqual(store.foreignActivity(new Set(), WS, cut()), { running: false, activeRecently: false });
});

test("foreignActivity: no workspace ⇒ reports nothing (can't attribute a chat to our window)", () => {
  const { db, store } = makeStore();
  insert(db, { id: "chat", status: "running", created_at: NOW - 5_000, updated_at: NOW - 1_000, env: envJson(WS) });
  assert.deepEqual(store.foreignActivity(new Set(), null, cut()), { running: false, activeRecently: false });
});

test("foreignActivity: a foreign root with no parseable env is treated as not-ours (can't attribute)", () => {
  const { db, store } = makeStore();
  insert(db, { id: "noenv", status: "running", created_at: NOW - 5_000, updated_at: NOW - 1_000, env: null });
  assert.deepEqual(store.foreignActivity(new Set(), WS, cut()), { running: false, activeRecently: false });
});

test("foreignActivity: subtasks are not roots and never count as a chat", () => {
  const { db, store } = makeStore();
  insert(db, { id: "root", status: "active", created_at: NOW - 5_000, updated_at: NOW - 1_000, env: envJson(WS) });
  insert(db, {
    id: "sub",
    parent: "root",
    status: "running",
    created_at: NOW - 900,
    updated_at: NOW - 100,
    env: envJson(WS),
  });
  // root is ours; the running row is a subtask (parent_id not null) → neither signal trips.
  assert.deepEqual(store.foreignActivity(new Set(["root"]), WS, cut()), { running: false, activeRecently: false });
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

test("awaitTurnSettled settles immediately on a terminal status, without waiting for the quiet window", async () => {
  const { db, store } = makeStore();
  // 'completed' is terminal → settle at once even though updated_at is 'now' and quietMs (5s) > timeoutMs (2s);
  // were isTerminal not honored in the settle predicate, this would time out (settled:false) instead.
  insert(db, { id: "done", status: "completed", created_at: Date.now() - 1_000, updated_at: Date.now() });
  const res = await awaitTurnSettled(store, "done", { pollMs: 5, quietMs: 5_000, timeoutMs: 2_000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.status, "completed");
});

test("awaitTurnSettled settles immediately on a real last_error", async () => {
  const { db, store } = makeStore();
  insert(db, { id: "e", status: "running", created_at: Date.now() - 1_000, updated_at: Date.now() });
  setTimeout(() => db.prepare("UPDATE tasks SET last_error='kaboom' WHERE id='e'").run(), 15);
  const res = await awaitTurnSettled(store, "e", { pollMs: 5, quietMs: 5_000, timeoutMs: 2_000 });
  assert.equal(res.settled, true);
  assert.equal(res.row?.last_error, "kaboom");
});

test("awaitTurnSettled records the max inter-bump gap while running (watchdog telemetry)", async () => {
  const { db, store } = makeStore();
  const b = Date.now();
  insert(db, { id: "g", status: "running", created_at: b - 50_000, updated_at: b - 40_000 });
  const upd = (status: string, updated: number): void =>
    void db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id='g'").run(status, updated);
  // gaps are differences of updated_at VALUES (epoch ms), so they're deterministic regardless of poll timing
  setTimeout(() => upd("running", b - 37_000), 20); // +3000 while running
  setTimeout(() => upd("running", b - 30_000), 40); // +7000 while running ← the max
  setTimeout(() => upd("active", b - 29_900), 60); // end of turn (small gap) → quiet → settle
  const res = await awaitTurnSettled(store, "g", { pollMs: 3, quietMs: 20, timeoutMs: 3_000 });
  assert.equal(res.settled, true);
  assert.equal(res.maxGapMs, 7_000);
});

// ── V6: result text + cost parsing ────────────────────────────────────────────────────────────────

test("parseCosts pulls token/cost fields; null/garbage → null; missing fields → 0", () => {
  const c = parseCosts('{"input":24848,"output":354,"cacheRead":16060,"cacheWrite":8783,"cost":0.063}');
  assert.deepEqual(c, { input: 24848, output: 354, cacheRead: 16060, cacheWrite: 8783, cost: 0.063 });
  assert.equal(parseCosts(null), null);
  assert.equal(parseCosts("not json"), null);
  assert.deepEqual(parseCosts("{}"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }); // absent → 0
});

test("readResultText returns the latest assistant message's content; null when none", () => {
  const { db, store } = makeStore();
  insertMessage(db, "t1", "user", { role: "user", content: "do it" }, 100);
  insertMessage(db, "t1", "assistant", { role: "assistant", content: "first pass" }, 200);
  insertMessage(db, "t1", "tool", { role: "tool", content: "Edited file" }, 300); // newer, but not assistant
  insertMessage(db, "t1", "assistant", { role: "assistant", content: "Done. Removed the redundant local." }, 400);
  assert.equal(store.readResultText("t1"), "Done. Removed the redundant local."); // latest assistant wins
  assert.equal(store.readResultText("nope"), null); // no messages for this task
});

test("readResultText flattens array content and ignores unparseable rows", () => {
  const { db, store } = makeStore();
  insertMessage(
    db,
    "a",
    "assistant",
    {
      content: [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ],
    },
    10,
  );
  assert.equal(store.readResultText("a"), "part one part two");
  db.prepare(
    "INSERT INTO messages (id, task_id, role, data, created_at) VALUES ('bad','b','assistant','{not json',20)",
  ).run();
  assert.equal(store.readResultText("b"), null); // bad JSON → null, never throws
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
