import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCompleted,
  isSettled,
  TASK_STATUSES,
  TASK_PRIORITIES,
  COMPLETED_STATUSES,
  SETTLED_STATUSES,
  CLAIMABLE_STATUS,
  ARTIFACT_KINDS,
  QUESTION_STATES,
} from "./types.js";

test("isCompleted: only done and analysis_done count as completed", () => {
  assert.equal(isCompleted("done"), true);
  assert.equal(isCompleted("analysis_done"), true);
  for (const s of ["staged", "pending", "in_progress", "needs_input", "blocked", "cancelled"] as const) {
    assert.equal(isCompleted(s), false, `${s} is not completed`);
  }
});

test("isSettled: await_task resolves on settled states, keeps waiting on transient ones", () => {
  // Settled — Bob isn't driving the task forward, so an await resolves here.
  for (const s of ["done", "analysis_done", "blocked", "cancelled", "needs_input"] as const) {
    assert.equal(isSettled(s), true, `${s} is settled`);
  }
  // Transient — a worker is (or will be) actively progressing it; keep polling.
  for (const s of ["staged", "pending", "in_progress"] as const) {
    assert.equal(isSettled(s), false, `${s} keeps the await waiting`);
  }
  // Every completed status is also settled (settled is the superset).
  for (const s of COMPLETED_STATUSES) assert.equal(isSettled(s), true);
});

test("constant sets pin the invariants the gates and dependency logic depend on", () => {
  // analysis_done + done both satisfy a dependency and the done-integrity gate keys on this set.
  assert.deepEqual([...COMPLETED_STATUSES].sort(), ["analysis_done", "done"]);
  // every completed status is a real status, and is what isCompleted accepts.
  for (const s of COMPLETED_STATUSES) {
    assert.ok(TASK_STATUSES.includes(s), `${s} is a known status`);
    assert.equal(isCompleted(s), true);
  }
  // await_task keys on this set; every member is a real status and a strict superset of completed.
  assert.deepEqual([...SETTLED_STATUSES].sort(), ["analysis_done", "blocked", "cancelled", "done", "needs_input"]);
  for (const s of SETTLED_STATUSES) assert.ok(TASK_STATUSES.includes(s), `${s} is a known status`);
  for (const s of COMPLETED_STATUSES) assert.ok(SETTLED_STATUSES.includes(s), `${s} is also settled`);
  // Only 'pending' is claimable; the claim chokepoint relies on this.
  assert.equal(CLAIMABLE_STATUS, "pending");
  assert.ok(TASK_STATUSES.includes(CLAIMABLE_STATUS));
  // Enumerations the schema/validators mirror.
  assert.deepEqual([...TASK_PRIORITIES], ["low", "medium", "high", "urgent"]);
  assert.deepEqual([...ARTIFACT_KINDS], ["file", "commit", "test"]);
  assert.deepEqual([...QUESTION_STATES], ["open", "answered", "timed_out"]);
});
