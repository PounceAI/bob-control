import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  createTask,
  getTask,
  setDependencies,
  updateStatus,
  listTasks,
  blockingDependencies,
  nextTask,
  claimTask,
  claimBlockReason,
  setBoardArmed,
} from "./db.js";

const TEST_DB = "./test-deps.db";

// Remove the DB and its WAL/SHM sidecars so a run always starts from a clean slate — a prior
// run whose `after` unlink lost a Windows file-lock race must not contaminate this run's tag space.
const wipeDb = () => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, `${TEST_DB}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      // not present — fine
    }
  }
};

describe("Task Dependencies", () => {
  before(() => {
    wipeDb();
    process.env.BOB_TASKS_DB = TEST_DB;
  });

  after(() => {
    wipeDb();
  });

  it("should parse NULL depends_on as empty array", () => {
    const task = createTask({ title: "Test task" });
    assert.deepEqual(task.depends_on, []);
  });

  it("should create task with dependencies", () => {
    const dep1 = createTask({ title: "Dependency 1" });
    const dep2 = createTask({ title: "Dependency 2" });
    const task = createTask({
      title: "Task with deps",
      depends_on: [dep1.id, dep2.id],
    });

    assert.deepEqual(task.depends_on, [dep1.id, dep2.id]);
  });

  it("should reject self-dependency", () => {
    const task = createTask({ title: "Task" });

    assert.throws(() => setDependencies(task.id, [task.id]), /cannot depend on itself/i);
  });

  it("should detect direct cycle", () => {
    const task1 = createTask({ title: "Task 1" });
    const task2 = createTask({ title: "Task 2", depends_on: [task1.id] });

    assert.throws(() => setDependencies(task1.id, [task2.id]), /cycle detected/i);
  });

  it("should detect indirect cycle", () => {
    const task1 = createTask({ title: "Task 1" });
    const task2 = createTask({ title: "Task 2", depends_on: [task1.id] });
    const task3 = createTask({ title: "Task 3", depends_on: [task2.id] });

    assert.throws(() => setDependencies(task1.id, [task3.id]), /cycle detected/i);
  });

  it("should allow clearing dependencies", () => {
    const dep = createTask({ title: "Dependency" });
    const task = createTask({ title: "Task", depends_on: [dep.id] });

    const updated = setDependencies(task.id, []);
    assert.deepEqual(updated?.depends_on, []);
  });

  it("should reject non-existent dependency", () => {
    assert.throws(() => createTask({ title: "Task", depends_on: [99999] }), /dependency #99999 does not exist/i);
  });

  it("should reject setting non-existent dependency", () => {
    const task = createTask({ title: "Task" });

    assert.throws(() => setDependencies(task.id, [99999]), /task #99999 does not exist/i);
  });

  it("should block task until all dependencies are done", () => {
    const dep1 = createTask({ title: "Dep 1" });
    const dep2 = createTask({ title: "Dep 2" });
    createTask({ title: "Task", depends_on: [dep1.id, dep2.id] });

    // Task should not be eligible yet
    const pending = listTasks({ status: "pending" });
    assert.ok(pending.some((t) => t.id === dep1.id));
    assert.ok(pending.some((t) => t.id === dep2.id));

    // Complete first dependency
    updateStatus(dep1.id, "done");

    // Task still blocked on dep2
    const dep1Done = getTask(dep1.id);
    const dep2Pending = getTask(dep2.id);
    assert.equal(dep1Done?.status, "done");
    assert.equal(dep2Pending?.status, "pending");

    // Complete second dependency
    updateStatus(dep2.id, "done");

    // Now task should be eligible
    const dep2Done = getTask(dep2.id);
    assert.equal(dep2Done?.status, "done");
  });

  it("should block forever on cancelled dependency", () => {
    const dep = createTask({ title: "Dependency" });
    const task = createTask({ title: "Task", depends_on: [dep.id] });

    updateStatus(dep.id, "cancelled");

    const cancelled = getTask(dep.id);
    assert.equal(cancelled?.status, "cancelled");

    // Task remains blocked (manual cleanup required)
    const blocked = getTask(task.id);
    assert.deepEqual(blocked?.depends_on, [dep.id]);
  });

  it("should allow multiple tasks to depend on same task", () => {
    const dep = createTask({ title: "Shared dependency" });
    const task1 = createTask({ title: "Task 1", depends_on: [dep.id] });
    const task2 = createTask({ title: "Task 2", depends_on: [dep.id] });

    assert.deepEqual(task1.depends_on, [dep.id]);
    assert.deepEqual(task2.depends_on, [dep.id]);

    // Complete dependency
    updateStatus(dep.id, "done");

    // Both tasks should now be unblocked
    const depDone = getTask(dep.id);
    assert.equal(depDone?.status, "done");
  });

  it("should handle complex dependency chains", () => {
    // Create a chain: task4 -> task3 -> task2 -> task1
    const task1 = createTask({ title: "Task 1" });
    const task2 = createTask({ title: "Task 2", depends_on: [task1.id] });
    const task3 = createTask({ title: "Task 3", depends_on: [task2.id] });
    const task4 = createTask({ title: "Task 4", depends_on: [task3.id] });

    assert.deepEqual(task2.depends_on, [task1.id]);
    assert.deepEqual(task3.depends_on, [task2.id]);
    assert.deepEqual(task4.depends_on, [task3.id]);

    // Complete in order
    updateStatus(task1.id, "done");
    updateStatus(task2.id, "done");
    updateStatus(task3.id, "done");

    // task4 should now be unblocked
    const t1 = getTask(task1.id);
    const t2 = getTask(task2.id);
    const t3 = getTask(task3.id);
    assert.equal(t1?.status, "done");
    assert.equal(t2?.status, "done");
    assert.equal(t3?.status, "done");
  });

  it("should handle diamond dependency pattern", () => {
    // Create diamond: task4 depends on task2 and task3, both depend on task1
    const task1 = createTask({ title: "Task 1" });
    const task2 = createTask({ title: "Task 2", depends_on: [task1.id] });
    const task3 = createTask({ title: "Task 3", depends_on: [task1.id] });
    const task4 = createTask({ title: "Task 4", depends_on: [task2.id, task3.id] });

    assert.deepEqual(task4.depends_on, [task2.id, task3.id]);

    // Complete task1
    updateStatus(task1.id, "done");

    // task2 and task3 are now unblocked, but task4 still blocked
    updateStatus(task2.id, "done");

    // task4 still blocked on task3
    const t3 = getTask(task3.id);
    assert.equal(t3?.status, "pending");

    // Complete task3
    updateStatus(task3.id, "done");

    // Now task4 is unblocked
    const t2 = getTask(task2.id);
    const t3Done = getTask(task3.id);
    assert.equal(t2?.status, "done");
    assert.equal(t3Done?.status, "done");
  });

  it("should update dependencies after creation", () => {
    const dep1 = createTask({ title: "Dep 1" });
    const dep2 = createTask({ title: "Dep 2" });
    const task = createTask({ title: "Task", depends_on: [dep1.id] });

    assert.deepEqual(task.depends_on, [dep1.id]);

    // Update to depend on both
    const updated = setDependencies(task.id, [dep1.id, dep2.id]);
    assert.deepEqual(updated?.depends_on, [dep1.id, dep2.id]);

    // Update to depend only on dep2
    const updated2 = setDependencies(task.id, [dep2.id]);
    assert.deepEqual(updated2?.depends_on, [dep2.id]);
  });

  it("should persist dependencies across DB reads", () => {
    const dep = createTask({ title: "Dependency" });
    const task = createTask({ title: "Task", depends_on: [dep.id] });

    // Re-read from DB
    const reloaded = getTask(task.id);
    assert.deepEqual(reloaded?.depends_on, [dep.id]);
  });

  it("blockingDependencies: a 'done' OR 'analysis_done' dependency is satisfied", () => {
    const a = createTask({ title: "analysis prereq" });
    const b = createTask({ title: "implement", depends_on: [a.id] });

    // pending dep blocks
    assert.match(blockingDependencies(getTask(b.id)!)!, /#\d+\[pending\]/);

    // analysis_done dep SATISFIES (the analyze→implement chain must not deadlock)
    updateStatus(a.id, "analysis_done");
    assert.equal(blockingDependencies(getTask(b.id)!), null);

    // done also satisfies
    const c = createTask({ title: "dep2" });
    const d = createTask({ title: "task2", depends_on: [c.id] });
    updateStatus(c.id, "done");
    assert.equal(blockingDependencies(getTask(d.id)!), null);
  });

  it("blockingDependencies: blocked/cancelled/staged/missing deps still block", () => {
    for (const st of ["blocked", "cancelled", "staged"] as const) {
      const dep = createTask({ title: `dep-${st}` });
      const task = createTask({ title: `task-${st}`, depends_on: [dep.id] });
      updateStatus(dep.id, st);
      assert.match(blockingDependencies(getTask(task.id)!)!, new RegExp(`\\[${st}\\]`));
    }
  });

  it("nextTask skips a dependency-blocked task and returns it once the dep is satisfied", () => {
    setBoardArmed(true);
    const tag = "nexttask-dep"; // tag-scope so prior tests' pending tasks don't shadow this check
    const a = createTask({ title: "dep root A", tags: [tag] });
    // B is urgent: without dependency enforcement nextTask would hand it back first.
    const b = createTask({ title: "dep child B (urgent)", priority: "urgent", depends_on: [a.id], tags: [tag] });

    assert.equal(
      nextTask({ tag })?.id,
      a.id,
      "urgent-but-blocked B skipped; eligible A returned despite lower priority",
    );

    updateStatus(a.id, "done");
    assert.equal(nextTask({ tag })?.id, b.id, "B becomes the next pull once A is done");
  });

  it("claimTask / claimBlockReason refuse a dependency-blocked task, then allow it once satisfied", () => {
    setBoardArmed(true);
    const a = createTask({ title: "claim dep root" });
    const b = createTask({ title: "claim dep child", depends_on: [a.id] });

    assert.match(claimBlockReason(b.id)!, /blocked on unfinished dependencies/i);
    assert.equal(claimTask(b.id, "bob"), null, "claim refused while the dep is pending");
    assert.equal(getTask(b.id)?.status, "pending", "left pending — not claimed out of order");

    // analysis_done satisfies (analyze→implement must not deadlock), matching blockingDependencies.
    updateStatus(a.id, "analysis_done");
    assert.equal(claimBlockReason(b.id), null, "no longer blocked once the dep reaches analysis_done");
    assert.equal(claimTask(b.id, "bob")?.status, "in_progress", "claimable once the dep is satisfied");
  });
});
