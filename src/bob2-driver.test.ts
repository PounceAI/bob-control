import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { Bob2TaskStore, type Bob2TaskRow } from "./bob2-taskstore.js";
import {
  InProcessDriver,
  isBob2Window,
  selectDriver,
  mapOutcome,
  type Bob2Host,
  type Bob2StartTask,
} from "./bob2-driver.js";
import type { BobDriver } from "./bob-driver.js";

const requireModule = createRequire(import.meta.url);

// V5 in-process driver: capability detection, the row→DispatchResult mapping, and the full
// snapshot→startTask→correlate→await loop against a synthetic bob.db matching the LIVE schema (TEXT ids,
// INTEGER created_at, last_error). The store and the test's writer share ONE in-memory connection, so the
// driver's polled reads can't race the test's transitions. The host (exports.startTask + workspace folder)
// is faked; the residual live behavior (Bob's exact stored `directory`) is the V7 gate.

const DIR = "C:/wt/a";

/** Shared in-memory db (live schema) + a store whose close() is neutered, so the driver's per-dispatch
 *  open/close doesn't drop the db. `clock` hands out monotonic created_at values to mimic Bob. */
function makeStore(): { db: DatabaseSync; store: Bob2TaskStore; seedRoot: (status: string) => string } {
  const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT, directory TEXT, created_at INTEGER, updated_at INTEGER, costs TEXT, last_error TEXT)",
  );
  const store = new Bob2TaskStore(db);
  store.close = () => {}; // keep the shared db alive across the driver's per-dispatch open/close
  let clock = 1000;
  let n = 0;
  const seedRoot = (status: string): string => {
    const id = `task-${++n}`;
    insert(db, { id, status, created_at: ++clock });
    return id;
  };
  return { db, store, seedRoot };
}

function insert(
  db: DatabaseSync,
  row: { id: string; parent?: string | null; status: string; created_at: number },
): void {
  db.prepare(
    "INSERT INTO tasks (id, parent_id, status, directory, created_at, updated_at, costs, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.parent ?? null, row.status, DIR, row.created_at, row.created_at, null, null);
}

const setStatus = (db: DatabaseSync, id: string, status: string): void => {
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
};
const setLastError = (db: DatabaseSync, id: string, err: string): void => {
  db.prepare("UPDATE tasks SET last_error = ? WHERE id = ?").run(err, id);
};

/** A fake Bob2Host. `startTask` is the hook where the test seeds the new task row. */
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

const fast = { writeApproval: () => {}, pollMs: 5, correlateTimeoutMs: 1000 };

// ── capability detection ───────────────────────────────────────────────────────────────────────

test("isBob2Window is true only when exports expose a callable startTask", () => {
  assert.equal(isBob2Window(makeHost({})), true);
  assert.equal(isBob2Window(makeHost({ noExports: true })), false);
  assert.equal(isBob2Window(makeHost({ startTask: null })), false);
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
  selectDriver(makeHost({}), make);
  assert.equal(built, 0);
  selectDriver(makeHost({ noExports: true }), make);
  assert.equal(built, 1);
});

// ── outcome mapping ────────────────────────────────────────────────────────────────────────────

test("mapOutcome honors a terminal row first, regardless of the settled flag", () => {
  const row = (status: string, last_error: string | null = null): Bob2TaskRow => ({
    id: "u7",
    parent_id: null,
    status,
    directory: DIR,
    created_at: 1,
    updated_at: 1,
    costs: null,
    last_error,
  });
  assert.equal(mapOutcome(row("completed"), true).status, "completed");
  assert.equal(mapOutcome(row("completed"), false).status, "completed"); // completed-in-the-same-tick isn't lost
  assert.equal(mapOutcome(row("error"), true).status, "aborted");
  assert.equal(mapOutcome(row("active", "boom"), false).status, "aborted"); // last_error wins over timeout
  assert.equal(mapOutcome(row("active"), false).status, "timeout"); // still live when the clock elapsed
  assert.equal(mapOutcome(row("active"), true).status, "idle"); // settled but non-terminal (defensive)
  assert.equal(mapOutcome(row("completed"), true).taskId, "u7");
  assert.match(mapOutcome(row("paused"), false).lastText, /status=paused/); // raw status kept for diagnostics
});

// ── connect / queryWorkspace ─────────────────────────────────────────────────────────────────────

test("connect throws when startTask is not reachable (not a Bob 2.0 window)", async () => {
  await assert.rejects(() => new InProcessDriver(makeHost({ noExports: true })).connect(), /not reachable/);
});

test("connect writes the auto-approve config exactly once across reconnects", async () => {
  let writes = 0;
  const driver = new InProcessDriver(makeHost({}), { writeApproval: () => writes++ });
  await driver.connect();
  await driver.connect();
  assert.equal(writes, 1);
});

test("a failed approval write leaves the driver unconnected so a later connect retries it", async () => {
  let attempts = 0;
  const driver = new InProcessDriver(makeHost({}), {
    writeApproval: () => {
      if (++attempts === 1) throw new Error("settings.json unparseable");
    },
  });
  await assert.rejects(() => driver.connect(), /unparseable/); // handle not set, approval not marked done
  await driver.connect(); // retries the write (would have been skipped if approvalWritten flipped early)
  assert.equal(attempts, 2);
});

test("queryWorkspace reports the host's open folder", async () => {
  assert.equal(await new InProcessDriver(makeHost({ folder: "C:/wt/z" })).queryWorkspace(), "C:/wt/z");
});

// ── dispatch: never throws, correlates, maps ──────────────────────────────────────────────────────

test("dispatch correlates the new root and resolves completed once it settles", async () => {
  const { db, store, seedRoot } = makeStore();
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("active")) }), {
    openStore: () => store,
    ...fast,
  });
  setTimeout(() => setStatus(db, id, "completed"), 20);
  const res = await driver.dispatch({ text: "do it", mode: "code" });
  assert.equal(res.status, "completed");
  assert.equal(res.taskId, id);
});

test("dispatch ignores a pre-existing root and a subtask, picking our new root", async () => {
  const { db, store, seedRoot } = makeStore();
  seedRoot("completed"); // pre-existing root, in the snapshot
  let ours = "";
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        ours = seedRoot("active"); // our new root
        insert(db, { id: "kid", parent: ours, status: "active", created_at: 99999 }); // newer subtask — excluded
      },
    }),
    { openStore: () => store, ...fast },
  );
  setTimeout(() => setStatus(db, ours, "completed"), 20);
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.taskId, ours);
  assert.equal(res.status, "completed");
});

test("dispatch maps a row that ends in 'error' to aborted", async () => {
  const { db, store, seedRoot } = makeStore();
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("active")) }), {
    openStore: () => store,
    ...fast,
  });
  setTimeout(() => setStatus(db, id, "error"), 20);
  assert.equal((await driver.dispatch({ text: "do it" })).status, "aborted");
});

test("dispatch maps a non-null last_error to aborted even if status stays 'active'", async () => {
  const { db, store, seedRoot } = makeStore();
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("active")) }), {
    openStore: () => store,
    ...fast,
  });
  setTimeout(() => setLastError(db, id, "exploded"), 20);
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /exploded/);
});

test("dispatch returns aborted (not a fake idle) when the task never appears in bob.db", async () => {
  const { store } = makeStore();
  const driver = new InProcessDriver(makeHost({ startTask: () => {} }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    correlateTimeoutMs: 40,
  });
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /could not correlate/);
});

test("dispatch tolerates a bob.db that doesn't exist until the first task runs (cold start)", async () => {
  const { store, seedRoot } = makeStore();
  let ready = false;
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        ready = true;
        seedRoot("completed"); // a turn fast enough we only ever see it terminal
      },
    }),
    { openStore: () => (ready ? store : null), ...fast },
  );
  assert.equal((await driver.dispatch({ text: "do it" })).status, "completed");
});

// ── never-throw contract + busy guard ─────────────────────────────────────────────────────────────

test("dispatch returns aborted (never throws) when no workspace folder is open, with no settings write", async () => {
  let writes = 0;
  const driver = new InProcessDriver(makeHost({ folder: null }), { writeApproval: () => writes++ });
  const res = await driver.dispatch({ text: "hi" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /no open workspace folder/);
  assert.equal(writes, 0); // validated BEFORE connect — a doomed dispatch doesn't mutate settings.json
});

test("dispatch returns aborted (never throws) when startTask itself throws", async () => {
  const { store } = makeStore();
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        throw new Error("extension host busy");
      },
    }),
    { openStore: () => store, ...fast },
  );
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /startTask failed: extension host busy/);
});

test("dispatch enforces a busy guard: a second concurrent dispatch is rejected", async () => {
  const { store, seedRoot } = makeStore();
  const driver = new InProcessDriver(makeHost({ startTask: () => void seedRoot("active") }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    correlateTimeoutMs: 1000,
  });
  const first = driver.dispatch({ text: "one", timeoutMs: 60 }); // stays in the await (active, never settles)
  await assert.rejects(() => driver.dispatch({ text: "two" }), /busy/);
  assert.equal((await first).status, "timeout"); // first drains to its wall-clock
});

test("dispatch writes auto-approve only once across multiple tasks", async () => {
  const { store, seedRoot } = makeStore();
  let writes = 0;
  const driver = new InProcessDriver(makeHost({ startTask: () => void seedRoot("completed") }), {
    openStore: () => store,
    writeApproval: () => writes++,
    pollMs: 5,
    correlateTimeoutMs: 1000,
  });
  await driver.dispatch({ text: "one" });
  await driver.dispatch({ text: "two" });
  assert.equal(writes, 1);
});
