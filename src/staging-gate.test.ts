import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDb,
  createTask,
  nextTask,
  claimTask,
  claimBlockReason,
  releaseTasks,
  isBoardArmed,
  setBoardArmed,
  getTask,
  listTasks,
} from "./db.js";

const DB = join(tmpdir(), "bob-test-staging.db");
function clean(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("staging + arming gate (incident A)", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("a fresh board defaults to armed", () => {
    assert.equal(isBoardArmed(), true);
  });

  it("a staged task is not pullable, not in the pending list, and cannot be claimed", () => {
    const s = createTask({ title: "staged work", staged: true, priority: "urgent" });
    assert.equal(s.status, "staged");
    assert.ok(!listTasks({ status: "pending" }).some((t) => t.id === s.id));
    assert.equal(claimTask(s.id, "worker"), null);
    assert.match(claimBlockReason(s.id) ?? "", /not pending/i);
  });

  it("release moves staged tasks to pending (by tag)", () => {
    const a = createTask({ title: "A", staged: true, tags: ["batch"] });
    const b = createTask({ title: "B", staged: true, tags: ["batch"] });
    const released = releaseTasks({ tag: "batch" });
    assert.ok(released >= 2);
    assert.equal(getTask(a.id)?.status, "pending");
    assert.equal(getTask(b.id)?.status, "pending");
  });

  it("a disarmed board pulls nothing and refuses claims", () => {
    const p = createTask({ title: "pending work" });
    assert.equal(getTask(p.id)?.status, "pending");

    setBoardArmed(false, "curating");
    assert.equal(isBoardArmed(), false);
    assert.equal(nextTask(), null); // disarm overrides priority
    assert.equal(claimTask(p.id, "worker"), null);
    assert.match(claimBlockReason(p.id) ?? "", /disarm/i);

    setBoardArmed(true);
    assert.equal(isBoardArmed(), true);
    assert.ok(claimTask(p.id, "worker")); // claimable again once armed
  });
});
