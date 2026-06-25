import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { Bob2TaskStore } from "./bob2-taskstore.js";
import {
  InProcessDriver,
  isBob2Window,
  selectDriver,
  mapOutcome,
  type Bob2Host,
  type Bob2StartTask,
} from "./bob2-driver.js";
import type { BobDriver } from "./bob-driver.js";
import type { Bob2TaskRow } from "./bob2-taskstore.js";

// V5 in-process driver: capability detection, the row→DispatchResult mapping, and the full
// dispatch→correlate→await loop against a synthetic bob.db. The store and the test's writer share ONE
// in-memory connection, so the driver's polled reads can't race the test's status transitions. No live
// Bob — the host (exports.startTask + workspace folder) is faked; the live behaviors are the V7 gate.

const requireModule = createRequire(import.meta.url);

const DIR = "C:/wt/a";

/** Shared in-memory db + a Bob2TaskStore over it whose close() is neutered, so the driver opening and
 *  closing the store per dispatch doesn't drop the db between calls. */
function makeStore(): { db: DatabaseSync; store: Bob2TaskStore } {
  const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks (id INTEGER PRIMARY KEY, parent_id INTEGER, status TEXT, directory TEXT, updated_at TEXT, costs TEXT)",
  );
  const store = new Bob2TaskStore(db);
  store.close = () => {}; // keep the shared in-memory db alive across the driver's per-dispatch open/close
  return { db, store };
}

/** Insert a task row, auto-assigning id = MAX(id)+1 (mirrors Bob creating a row). Returns the new id. */
function insertRow(db: DatabaseSync, parent: number | null, status: string, dir: string): number {
  const { m } = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM tasks").get() as { m: number };
  const id = m + 1;
  db.prepare("INSERT INTO tasks (id, parent_id, status, directory, updated_at, costs) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    parent,
    status,
    dir,
    "2026-06-25T00:00:00Z",
    null,
  );
  return id;
}

function setStatus(db: DatabaseSync, id: number, status: string): void {
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
}

/** A fake Bob2Host with a programmable startTask. `folder` defaults to DIR; pass null to simulate no
 *  open workspace. `onStart` fires inside startTask (where the test inserts the new task row). */
function makeHost(opts: {
  startTask?: Bob2StartTask["startTask"] | null;
  folder?: string | null;
  noExports?: boolean;
}): Bob2Host {
  // null exports = extension absent; an exports object missing startTask = present but not a 2.0 build.
  const ex: Bob2StartTask | null = opts.noExports
    ? null
    : opts.startTask === null
      ? ({} as Bob2StartTask)
      : { startTask: opts.startTask ?? (() => {}) };
  return {
    exports: () => ex,
    workspaceFolder: () => (opts.folder === undefined ? DIR : opts.folder),
  };
}

// ── capability detection ───────────────────────────────────────────────────────────────────────

test("isBob2Window is true only when exports expose a callable startTask", () => {
  assert.equal(isBob2Window(makeHost({})), true);
  assert.equal(isBob2Window(makeHost({ noExports: true })), false); // extension absent / not activated
  assert.equal(isBob2Window(makeHost({ startTask: null })), false); // exports present but no startTask
});

test("selectDriver returns the in-process driver on a 2.0 window, else the IPC fallback", () => {
  const ipc = { tag: "ipc" } as unknown as BobDriver;
  assert.ok(selectDriver(makeHost({}), () => ipc) instanceof InProcessDriver);
  assert.equal(
    selectDriver(makeHost({ noExports: true }), () => ipc),
    ipc,
  );
});

test("selectDriver only constructs the IPC client on the 1.x path", () => {
  let built = 0;
  const make = (): BobDriver => {
    built++;
    return {} as BobDriver;
  };
  selectDriver(makeHost({}), make); // 2.0 window — must not touch the pipe
  assert.equal(built, 0);
  selectDriver(makeHost({ noExports: true }), make);
  assert.equal(built, 1);
});

// ── outcome mapping ────────────────────────────────────────────────────────────────────────────

test("mapOutcome maps terminal status; unsettled → timeout, non-terminal-after-run → idle", () => {
  const row = (status: string): Bob2TaskRow => ({
    id: 7,
    parent_id: null,
    status,
    directory: DIR,
    updated_at: null,
    costs: null,
  });
  assert.equal(mapOutcome(row("completed"), true).status, "completed");
  assert.equal(mapOutcome(row("error"), true).status, "aborted");
  assert.equal(mapOutcome(row("active"), true).status, "idle"); // settled back to idle without completing
  assert.equal(mapOutcome(row("paused"), true).status, "idle");
  assert.equal(mapOutcome(row("running"), false).status, "timeout"); // wall-clock elapsed mid-run
  assert.equal(mapOutcome(null, true).status, "idle"); // never correlated
  assert.equal(mapOutcome(row("completed"), true).taskId, "7"); // numeric id surfaced as string
  assert.equal(mapOutcome(null, false).taskId, null);
});

// ── connect / queryWorkspace ─────────────────────────────────────────────────────────────────────

test("connect throws when startTask is not reachable (not a Bob 2.0 window)", async () => {
  const driver = new InProcessDriver(makeHost({ noExports: true }));
  await assert.rejects(() => driver.connect(), /not reachable/);
});

test("connect writes the auto-approve config exactly once across reconnects", async () => {
  let writes = 0;
  const driver = new InProcessDriver(makeHost({}), { writeApproval: () => writes++ });
  await driver.connect();
  await driver.connect();
  assert.equal(writes, 1);
});

test("queryWorkspace reports the host's open folder", async () => {
  const driver = new InProcessDriver(makeHost({ folder: "C:/wt/z" }));
  assert.equal(await driver.queryWorkspace(), "C:/wt/z");
});

test("dispatch throws when no workspace folder is open to correlate against", async () => {
  const driver = new InProcessDriver(makeHost({ folder: null }), { writeApproval: () => {} });
  await assert.rejects(() => driver.dispatch({ text: "hi" }), /no open workspace folder/);
});

// ── dispatch: correlate + await ──────────────────────────────────────────────────────────────────

test("dispatch correlates the new root row and resolves completed once it settles", async () => {
  const { db, store } = makeStore();
  let id = 0;
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = insertRow(db, null, "running", DIR)) }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    correlateTimeoutMs: 1000,
  });
  setTimeout(() => setStatus(db, id, "completed"), 20);
  const res = await driver.dispatch({ text: "do it", mode: "code" });
  assert.equal(res.status, "completed");
  assert.equal(res.taskId, String(id));
});

test("dispatch ignores a concurrent subtask and another directory's row, picking our new root", async () => {
  const { db, store } = makeStore();
  insertRow(db, null, "completed", DIR); // pre-baseline row in our dir → baseline=1
  let ours = 0;
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        ours = insertRow(db, null, "running", DIR); // our new root (id 2)
        insertRow(db, ours, "running", DIR); // a subtask of ours (id 3) — excluded
        insertRow(db, null, "running", "C:/wt/b"); // a racing root in another dir (id 4) — excluded
      },
    }),
    { openStore: () => store, writeApproval: () => {}, pollMs: 5, correlateTimeoutMs: 1000 },
  );
  setTimeout(() => setStatus(db, ours, "completed"), 20);
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.taskId, String(ours)); // id 2, not the newer subtask (3) or other-dir root (4)
  assert.equal(res.status, "completed");
});

test("dispatch maps a row that ends in 'error' to aborted", async () => {
  const { db, store } = makeStore();
  let id = 0;
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = insertRow(db, null, "running", DIR)) }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    correlateTimeoutMs: 1000,
  });
  setTimeout(() => setStatus(db, id, "error"), 20);
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "aborted");
});

test("dispatch returns idle when no task row ever materializes (correlation times out)", async () => {
  const { store } = makeStore();
  const driver = new InProcessDriver(makeHost({ startTask: () => {} }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    correlateTimeoutMs: 40, // nothing inserted → give up fast
  });
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "idle");
  assert.equal(res.taskId, null);
});

test("dispatch tolerates a bob.db that doesn't exist until the first task runs (lazy creation)", async () => {
  const { db, store } = makeStore();
  let ready = false; // the store 'doesn't exist' until startTask 'creates' it
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        ready = true;
        insertRow(db, null, "completed", DIR); // a turn fast enough that we only ever see it terminal
      },
    }),
    {
      openStore: () => {
        if (!ready) throw new Error("bob.db not found");
        return store;
      },
      writeApproval: () => {},
      pollMs: 5,
      correlateTimeoutMs: 1000,
    },
  );
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "completed");
});

test("dispatch writes auto-approve only once across multiple tasks", async () => {
  const { db, store } = makeStore();
  let writes = 0;
  const driver = new InProcessDriver(makeHost({ startTask: () => void insertRow(db, null, "completed", DIR) }), {
    openStore: () => store,
    writeApproval: () => writes++,
    pollMs: 5,
    correlateTimeoutMs: 1000,
  });
  await driver.dispatch({ text: "one" });
  await driver.dispatch({ text: "two" });
  assert.equal(writes, 1);
});
