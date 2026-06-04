import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTask,
  getTask,
  listTasks,
  setDependencies,
  setBoardArmed,
  claimTask,
  incrementRetryAttempts,
  reclaimStaleInProgress,
  askQuestion,
  getOpenQuestion,
  getQuestion,
} from "./db.js";

const TEST_DB = join(tmpdir(), "bob-test-atomicity.db");
const wipe = () => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, `${TEST_DB}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      /* not present */
    }
  }
};

describe("board atomicity & transactions", () => {
  before(() => {
    wipe();
    process.env.BOB_TASKS_DB = TEST_DB;
    setBoardArmed(true);
  });
  after(wipe);

  it("claimTask is atomic: exactly one of two claims wins; the loser gets null", () => {
    const t = createTask({ title: "claimable" });
    const first = claimTask(t.id, "alice");
    const second = claimTask(t.id, "bob");

    assert.equal(first?.id, t.id);
    assert.equal(first?.status, "in_progress");
    assert.equal(first?.assignee, "alice");
    assert.equal(second, null, "second claim must lose, not silently re-own the task");
    assert.equal(getTask(t.id)?.assignee, "alice", "winner keeps ownership");
  });

  it("incrementRetryAttempts increments in SQL (no read-modify-write) and is monotonic", () => {
    const t = createTask({ title: "retryable" });
    assert.equal(t.retry_attempts, 0);
    assert.equal(incrementRetryAttempts(t.id)?.retry_attempts, 1);
    assert.equal(incrementRetryAttempts(t.id)?.retry_attempts, 2);
    assert.equal(getTask(t.id)?.retry_attempts, 2);
    assert.equal(incrementRetryAttempts(999999), null, "missing task → null");
  });

  it("createTask rolls back: a bad dependency throws and leaves NO task row behind", () => {
    const before = listTasks({}).length;
    assert.throws(() => createTask({ title: "bad", depends_on: [424242] }), /does not exist/i);
    assert.equal(listTasks({}).length, before, "no partial row committed");
  });

  it("setDependencies rolls back: a cycle throws and leaves the existing deps unchanged", () => {
    const a = createTask({ title: "A" });
    const b = createTask({ title: "B", depends_on: [a.id] }); // B already depends on A
    const c = createTask({ title: "C" });
    // Setting A -> B would close the cycle A->B->A.
    assert.throws(() => setDependencies(a.id, [b.id]), /cycle/i);
    assert.deepEqual(getTask(a.id)?.depends_on, [], "A's deps untouched by the rejected write");
    // A non-existent dep also throws without partially applying.
    assert.throws(() => setDependencies(a.id, [b.id, 707070]), /does not exist/i);
    assert.deepEqual(getTask(a.id)?.depends_on, []);
    // A genuinely acyclic edge (A -> C) still commits.
    assert.deepEqual(setDependencies(a.id, [c.id])?.depends_on, [c.id]);
  });

  it("reclaimStaleInProgress re-queues only this assignee's stranded in_progress tasks", () => {
    const a = createTask({ title: "stranded" });
    claimTask(a.id, "bob"); // in_progress @bob
    const b = createTask({ title: "other-owner" });
    claimTask(b.id, "alice"); // in_progress @alice
    const c = createTask({ title: "still-pending" }); // pending, never claimed

    const n = reclaimStaleInProgress("bob");
    assert.equal(n, 1, "only bob's in_progress task is reclaimed");
    assert.equal(getTask(a.id)?.status, "pending", "stranded task re-queued");
    assert.equal(getTask(b.id)?.status, "in_progress", "another assignee's task is untouched");
    assert.equal(getTask(c.id)?.status, "pending", "an already-pending task is untouched");
  });

  it("askQuestion is atomic: supersede + insert + park needs_input happen together", () => {
    const t = createTask({ title: "asker" });
    claimTask(t.id, "bob");
    const q1 = askQuestion(t.id, "first?")!;
    const q2 = askQuestion(t.id, "second?")!; // supersedes q1

    assert.equal(getTask(t.id)?.status, "needs_input", "task parked needs_input");
    assert.equal(getOpenQuestion(t.id)?.question_id, q2.question_id, "only the latest question is open");
    assert.equal(getQuestion(q1.question_id)?.status, "timed_out", "prior question superseded");
    // Exactly one open question exists for the task (the supersede was atomic with the insert).
    assert.equal(getOpenQuestion(t.id)?.question_id, q2.question_id);
  });
});
