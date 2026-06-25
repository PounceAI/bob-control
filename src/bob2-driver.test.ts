import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Bob2TaskStore, type Bob2TaskRow } from "./bob2-taskstore.js";
import {
  InProcessDriver,
  isBob2Window,
  selectDriver,
  mapOutcome,
  toBob2Mode,
  type Bob2Host,
  type Bob2StartTask,
} from "./bob2-driver.js";
import type { BobDriver } from "./bob-driver.js";

const requireModule = createRequire(import.meta.url);

// V5 in-process driver against a synthetic bob.db matching the LIVE schema + lifecycle (verified by
// watching a real dispatched task): TEXT uuids, INTEGER created_at/updated_at, last_error "null" sentinel,
// and the active→running→active turn lifecycle (a turn is done once it leaves 'running' and goes quiet).
// The store + the test's writer share ONE in-memory connection so reads can't race the writes.

const DIR = "C:/wt/a";

function makeStore() {
  const { DatabaseSync } = requireModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT, directory TEXT, created_at INTEGER, updated_at INTEGER, costs TEXT, last_error TEXT)",
  );
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, data TEXT, created_at INTEGER)");
  const store = new Bob2TaskStore(db);
  store.close = () => {}; // keep the shared db alive across the driver's per-dispatch open/close
  const base = Date.now() - 100_000; // created_at values in the recent past, so updated_at can advance past them
  let clock = 0;
  let n = 0;
  // A new root, created but not yet started (updated_at == created_at).
  const seedRoot = (status: string): string => {
    const id = `task-${++n}`;
    const ca = base + ++clock * 1000;
    db.prepare(
      "INSERT INTO tasks (id, parent_id, status, directory, created_at, updated_at, costs, last_error) VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL)",
    ).run(id, status, DIR, ca, ca);
    return id;
  };
  // Bob touching the row mid/end-of-turn: advances updated_at to "now" (so it reads as run, then quiet).
  const bump = (id: string, status: string): void =>
    void db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
  const setLastError = (id: string, err: string): void =>
    void db.prepare("UPDATE tasks SET last_error = ? WHERE id = ?").run(err, id);
  const seedSubtask = (parent: string, status: string): void => {
    db.prepare(
      "INSERT INTO tasks (id, parent_id, status, directory, created_at, updated_at, costs, last_error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
    ).run(`sub-${++n}`, parent, status, DIR, base + ++clock * 1000, base + clock * 1000);
  };
  // Bob's end-of-turn artifacts: the costs JSON + a final assistant message (the result text).
  const finishWith = (id: string, opts: { result?: string; output?: number }): void => {
    if (opts.output != null) db.prepare("UPDATE tasks SET costs = ? WHERE id = ?").run(`{"output":${opts.output}}`, id);
    if (opts.result != null)
      db.prepare("INSERT INTO messages (id, task_id, role, data, created_at) VALUES (?, ?, 'assistant', ?, ?)").run(
        `msg-${++n}`,
        id,
        JSON.stringify({ role: "assistant", content: opts.result }),
        Date.now(),
      );
  };
  return { db, store, seedRoot, bump, setLastError, seedSubtask, finishWith };
}

function makeHost(opts: {
  startTask?: Bob2StartTask["startTask"] | null;
  folder?: string | null;
  noExports?: boolean;
}): Bob2Host {
  const ex: Bob2StartTask | null = opts.noExports
    ? null
    : opts.startTask === null
      ? ({} as Bob2StartTask)
      : { startTask: opts.startTask ?? (() => {}) };
  const folder = opts.folder === undefined ? DIR : opts.folder;
  // Mirror the real vscode.WorkspaceFolder shape Bob reads (`.uri.fsPath`), so a test can assert the
  // driver forwards the OBJECT (not the fsPath string) into startTask.
  const folderObj = folder === null ? null : { uri: { fsPath: folder } };
  return {
    exports: () => ex,
    workspaceFolder: () => folder,
    workspaceFolderObject: () => folderObj,
  };
}

const fast = { writeApproval: () => {}, pollMs: 5, quietMs: 25, correlateTimeoutMs: 1000 };

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

test("mapOutcome: real error → aborted, settled → completed, unsettled → timeout", () => {
  const r = (over: Partial<Bob2TaskRow> = {}): Bob2TaskRow => ({
    id: "u7",
    parent_id: null,
    status: "active",
    directory: DIR,
    created_at: 1,
    updated_at: 2,
    costs: null,
    last_error: null,
    ...over,
  });
  assert.equal(mapOutcome(r({ last_error: "boom" }), true).status, "aborted");
  assert.equal(mapOutcome(r({ last_error: "null" }), true).status, "completed"); // sentinel is NOT an error
  assert.equal(mapOutcome(r(), true).status, "completed");
  assert.equal(mapOutcome(r(), false).status, "timeout");
  assert.equal(mapOutcome(r(), true).taskId, "u7");
  assert.equal(mapOutcome(null, false).taskId, null);
  assert.match(mapOutcome(r({ status: "running" }), false).lastText, /status=running/);
  // extras: result only surfaces on completion; tokensUsed on any outcome
  assert.equal(mapOutcome(r(), true, { result: "summary", tokensUsed: 42 }).result, "summary");
  assert.equal(mapOutcome(r(), false, { result: "partial", tokensUsed: 42 }).result, ""); // not on timeout
  assert.equal(mapOutcome(r({ last_error: "boom" }), true, { result: "x", tokensUsed: 7 }).result, ""); // not on abort
  assert.equal(mapOutcome(r(), false, { tokensUsed: 42 }).tokensUsed, 42);
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
  await assert.rejects(() => driver.connect(), /unparseable/);
  await driver.connect();
  assert.equal(attempts, 2);
});

test("queryWorkspace reports the host's open folder", async () => {
  assert.equal(await new InProcessDriver(makeHost({ folder: "C:/wt/z" })).queryWorkspace(), "C:/wt/z");
});

// ── dispatch: never throws, correlates, follows the lifecycle ─────────────────────────────────────

test("dispatch correlates the new root and resolves completed once the turn leaves 'running' and quiets", async () => {
  const { store, seedRoot, bump } = makeStore();
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("running")) }), {
    openStore: () => store,
    ...fast,
  });
  setTimeout(() => bump(id, "active"), 15); // turn ends → back to active
  const res = await driver.dispatch({ text: "do it", mode: "code" });
  assert.equal(res.status, "completed");
  assert.equal(res.taskId, id);
});

test("dispatch captures Bob's result text + output tokens from bob.db on completion", async () => {
  const { store, seedRoot, bump, finishWith } = makeStore();
  let id = "";
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        id = seedRoot("running");
        finishWith(id, { result: "Done — removed the redundant local.", output: 354 });
      },
    }),
    { openStore: () => store, ...fast },
  );
  setTimeout(() => bump(id, "active"), 15);
  const res = await driver.dispatch({ text: "do it", mode: "code" });
  assert.equal(res.status, "completed");
  assert.equal(res.result, "Done — removed the redundant local."); // the latest assistant message
  assert.equal(res.tokensUsed, 354); // costs.output
});

test("dispatch reports tokens but NOT result text on a non-completion (timeout)", async () => {
  const { store, seedRoot, finishWith } = makeStore();
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        const id = seedRoot("running"); // stays running → never settles → times out
        finishWith(id, { result: "partial, do not surface", output: 120 });
      },
    }),
    { openStore: () => store, writeApproval: () => {}, pollMs: 5, quietMs: 25, correlateTimeoutMs: 1000 },
  );
  const res = await driver.dispatch({ text: "do it", timeoutMs: 40 });
  assert.equal(res.status, "timeout");
  assert.equal(res.result, ""); // a partial turn's last message must not read as the result
  assert.equal(res.tokensUsed, 120); // tokens still accounted
});

test("dispatch ignores a pre-existing root and a subtask, picking our new root", async () => {
  const { store, seedRoot, bump, seedSubtask } = makeStore();
  seedRoot("active"); // pre-existing root, in the snapshot
  let ours = "";
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        ours = seedRoot("running");
        seedSubtask(ours, "running"); // a subtask of ours — excluded from correlation
      },
    }),
    { openStore: () => store, ...fast },
  );
  setTimeout(() => bump(ours, "active"), 15);
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.taskId, ours);
  assert.equal(res.status, "completed");
});

test("dispatch maps a real last_error to aborted", async () => {
  const { store, seedRoot, setLastError } = makeStore();
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("running")) }), {
    openStore: () => store,
    ...fast,
  });
  setTimeout(() => setLastError(id, "exploded"), 15);
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /exploded/);
});

test("dispatch treats the last_error 'null' sentinel as success, not an error", async () => {
  const { store, seedRoot, bump, setLastError } = makeStore();
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("running")) }), {
    openStore: () => store,
    ...fast,
  });
  setTimeout(() => setLastError(id, "null"), 8); // the success sentinel — must NOT abort
  setTimeout(() => bump(id, "active"), 16);
  assert.equal((await driver.dispatch({ text: "do it" })).status, "completed");
});

test("dispatch returns aborted (not a fake completion) when the task never appears in bob.db", async () => {
  const { store } = makeStore();
  const driver = new InProcessDriver(makeHost({ startTask: () => {} }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    quietMs: 25,
    correlateTimeoutMs: 40,
  });
  const res = await driver.dispatch({ text: "do it" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /could not correlate/);
});

test("dispatch tolerates a bob.db that doesn't exist until the first task runs (cold start)", async () => {
  const { store, seedRoot, bump } = makeStore();
  let ready = false;
  let id = "";
  const driver = new InProcessDriver(
    makeHost({
      startTask: () => {
        ready = true;
        id = seedRoot("running");
      },
    }),
    { openStore: () => (ready ? store : null), ...fast },
  );
  setTimeout(() => bump(id, "active"), 15);
  assert.equal((await driver.dispatch({ text: "do it" })).status, "completed");
});

test("toBob2Mode remaps removed 1.x built-ins to agent; passes through 2.0 built-ins and custom modes", () => {
  // removed 1.x built-ins our router still emits → agent (Bob 2.0 throws "Mode not found" on these)
  for (const m of ["code", "advanced", "orchestrator"]) assert.equal(toBob2Mode(m), "agent");
  // 2.0 built-ins pass through
  for (const m of ["agent", "ask", "plan", "review"]) assert.equal(toBob2Mode(m), m);
  // CUSTOM modes pass through unchanged — Bob 2.0 loads custom_modes.yaml and resolves them
  for (const m of ["refactor", "devsecops", "my-custom-mode"]) assert.equal(toBob2Mode(m), m);
  // no mode → Bob's default coding mode
  assert.equal(toBob2Mode(undefined), "agent");
  assert.equal(toBob2Mode(null), "agent");
});

test("dispatch forwards the WorkspaceFolder OBJECT (not the string) and the translated mode into startTask", async () => {
  const { store, seedRoot, bump } = makeStore();
  let seenWs: unknown = "UNSET"; // sentinel: stays unset if startTask is never called
  let seenMode: unknown = "UNSET";
  let id = "";
  const host = makeHost({
    folder: "C:/wt/q",
    startTask: (o) => {
      seenWs = o.workspaceFolder;
      seenMode = o.mode;
      id = seedRoot("running");
    },
  });
  const driver = new InProcessDriver(host, { openStore: () => store, ...fast });
  setTimeout(() => bump(id, "active"), 15);
  await driver.dispatch({ text: "do it", mode: "code" });
  // the exact object the host hands out — Bob reads `.uri.fsPath` off it; a bare fsPath string throws in Bob
  assert.equal(seenWs, host.workspaceFolderObject());
  assert.notEqual(typeof seenWs, "string");
  assert.equal(seenMode, "agent"); // board "code" → Bob 2.0 "agent"
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
  const driver = new InProcessDriver(makeHost({ startTask: () => void seedRoot("running") }), {
    openStore: () => store,
    writeApproval: () => {},
    pollMs: 5,
    quietMs: 25,
    correlateTimeoutMs: 1000,
  });
  const first = driver.dispatch({ text: "one", timeoutMs: 60 }); // stays 'running' → never settles → times out
  await assert.rejects(() => driver.dispatch({ text: "two" }), /busy/);
  assert.equal((await first).status, "timeout");
});

test("dispatch writes auto-approve only once across multiple tasks", async () => {
  const { store, seedRoot, bump } = makeStore();
  let writes = 0;
  let id = "";
  const driver = new InProcessDriver(makeHost({ startTask: () => void (id = seedRoot("running")) }), {
    openStore: () => store,
    writeApproval: () => writes++,
    pollMs: 5,
    quietMs: 20,
    correlateTimeoutMs: 1000,
  });
  setTimeout(() => bump(id, "active"), 10);
  await driver.dispatch({ text: "one" });
  setTimeout(() => bump(id, "active"), 10);
  await driver.dispatch({ text: "two" });
  assert.equal(writes, 1);
});
