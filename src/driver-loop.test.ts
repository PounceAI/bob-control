import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, getTask, getDb, setBoardArmed, listTasks } from "./db.js";
import { parseOpts } from "./worker.js";
import { isCompleted } from "./types.js";
import { driveOnce, runDriverLoop, type DriverLoopConfig } from "./driver-loop.js";
import type { BobDriver } from "./bob-driver.js";
import type { DispatchCore, DispatchResult } from "./bob-ipc.js";

// The transport-agnostic drain loop: route → claim → dispatch(driver) → finalize, against a temp board
// and a fake BobDriver. cwd is a non-git temp dir so the git evidence/checkpoint ops no-op (never touch
// the real repo). The driver is faked, so this is offline — the InProcessDriver itself is covered separately.

const DB = join(tmpdir(), "bob-test-driver-loop.db");
const wipeDb = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, `${DB}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      /* absent */
    }
  }
};
let CWD = "";

before(() => {
  wipeDb();
  process.env.BOB_TASKS_DB = DB;
  CWD = mkdtempSync(join(tmpdir(), "bob-loop-cwd-")); // non-git → git ops no-op safely
  getDb();
});
beforeEach(() => {
  getDb().exec("DELETE FROM tasks");
  setBoardArmed(true);
});

/** A BobDriver whose dispatch returns a fixed result and records its calls. */
function fakeDriver(result: Partial<DispatchResult> = {}) {
  const calls: DispatchCore[] = [];
  let closed = false;
  let connects = 0;
  const driver = {
    calls,
    get closed() {
      return closed;
    },
    get connects() {
      return connects;
    },
    connect: async () => void connects++,
    queryWorkspace: async () => null,
    dispatch: async (o: DispatchCore): Promise<DispatchResult> => {
      calls.push(o);
      return { taskId: "bob2-1", result: "", lastText: "", status: "completed", tokensUsed: 0, turns: 0, ...result };
    },
    close: () => void (closed = true),
  };
  return driver as typeof driver & BobDriver;
}

function cfg(driver: BobDriver, argv: string[] = []): DriverLoopConfig {
  return { driver, opts: parseOpts(["--max-risk", "elevated", ...argv]), cwd: CWD, sleep: async () => {} };
}

test("driveOnce returns false when the board has nothing eligible", async () => {
  assert.equal(await driveOnce(cfg(fakeDriver())), false);
});

test("driveOnce routes, dispatches, and records a completion", async () => {
  const t = createTask({ title: "Do the thing", description: "details here", mode: "code" });
  const driver = fakeDriver({ status: "completed", result: "did it" });
  assert.equal(await driveOnce(cfg(driver)), true);
  assert.equal(driver.calls.length, 1);
  assert.equal(driver.calls[0].mode, "code");
  assert.match(driver.calls[0].text, /Do the thing/);
  assert.match(driver.calls[0].text, /details here/);
  assert.ok(isCompleted(getTask(t.id)!.status)); // done / analysis_done
});

test("driveOnce blocks a task on a non-retryable failure", async () => {
  const t = createTask({ title: "will fail", mode: "code" });
  const res = await driveOnce(cfg(fakeDriver({ status: "aborted", lastText: "extension host died" })));
  assert.equal(res, true);
  assert.equal(getTask(t.id)!.status, "blocked");
});

test("driveOnce retries a transient failure when --retry is set (re-queues pending)", async () => {
  const t = createTask({ title: "transient", mode: "code" });
  await driveOnce(cfg(fakeDriver({ status: "timeout" }), ["--retry", "2"]));
  const after = getTask(t.id)!;
  assert.equal(after.status, "pending");
  assert.equal(after.retry_attempts, 1);
});

test("driveOnce dry-run neither claims nor dispatches", async () => {
  const t = createTask({ title: "peek", mode: "code" });
  const driver = fakeDriver();
  assert.equal(await driveOnce(cfg(driver, ["--dry-run"])), true);
  assert.equal(driver.calls.length, 0);
  assert.equal(getTask(t.id)!.status, "pending"); // untouched
});

test("driveOnce honors the risk gate (a standard-risk task is skipped under --max-risk safe)", async () => {
  createTask({ title: "writes code", mode: "code" });
  // pickEligible at safe should gate the code task → nothing eligible.
  const config: DriverLoopConfig = {
    driver: fakeDriver(),
    opts: parseOpts(["--max-risk", "safe"]),
    cwd: CWD,
    sleep: async () => {},
  };
  assert.equal(await driveOnce(config), false);
});

test("runDriverLoop drains the board and stops on --once, closing the driver", async () => {
  createTask({ title: "one task", mode: "code" });
  const driver = fakeDriver({ status: "completed", result: "ok" });
  const events: string[] = [];
  await runDriverLoop({ ...cfg(driver, ["--once"]), emit: (t) => events.push(t) });
  assert.equal(driver.connects, 1);
  assert.equal(driver.calls.length, 1);
  assert.ok(driver.closed);
  assert.ok(events.includes("connected") && events.includes("stopped"));
  assert.equal(listTasks({ status: "pending" }).length, 0);
});

test("runDriverLoop aborts cleanly when the driver can't connect", async () => {
  const driver = fakeDriver();
  driver.connect = async () => {
    throw new Error("not a Bob 2.0 window");
  };
  const events: string[] = [];
  await runDriverLoop({ ...cfg(driver, ["--once"]), emit: (t, d) => events.push(`${t}:${JSON.stringify(d)}`) });
  assert.ok(events.some((e) => e.startsWith("error:")));
  assert.equal(driver.calls.length, 0);
});

after(() => {
  wipeDb();
  if (CWD) rmSync(CWD, { recursive: true, force: true });
});
