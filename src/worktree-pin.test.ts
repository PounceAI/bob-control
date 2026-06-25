import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { createTask, listTasks, nextTask, claimTask, getTask, reclaimStaleInProgress, setBoardArmed } from "./db.js";

// T6 — per-task worktree pin via the `worktree:<name>` tag convention (zero schema). A worker launched
// `--tag worktree:<name>` (extension: bobTasks.tag) filters to its tasks through the ONE exact-match tag
// filter that listTasks/pickEligible AND nextTask/get_next_task both share. These pin the AC ("a
// worktree:feat-a task is only ever pulled by feat-a's worker"), the caveat that an UNTAGGED worker
// still pulls everything, and that the startup reclaim is now tag-scoped so two workers can't cross-fire.

const TEST_DB = "./test-worktree-pin.db";
const wipeDb = () => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`, `${TEST_DB}-journal`]) {
    try {
      unlinkSync(f);
    } catch {
      // not present — fine
    }
  }
};

describe("worktree:<name> task pin", () => {
  // Created once; all read-only tests are order-independent (they only query by their own tag). feat-b
  // is created BEFORE feat-a so a tag-BLIND nextTask would return feat-b — making the feat-a assertion
  // distinguishing (it would fail if the tag filter were a no-op).
  let b: ReturnType<typeof createTask>;
  let a: ReturnType<typeof createTask>;
  let a2: ReturnType<typeof createTask>;

  before(() => {
    wipeDb();
    process.env.BOB_TASKS_DB = TEST_DB;
    setBoardArmed(true); // nextTask returns null on a disarmed board
    b = createTask({ title: "feat-b work", tags: ["worktree:feat-b"] });
    a = createTask({ title: "feat-a work", tags: ["worktree:feat-a"] });
    a2 = createTask({ title: "feat-a-2 work", tags: ["worktree:feat-a-2"] });
  });
  after(() => wipeDb());

  it("a feat-a worker pulls only worktree:feat-a tasks, never feat-b's (the AC)", () => {
    // pickEligible's path (listTasks) and get_next_task's path (nextTask) both isolate to feat-a.
    assert.deepEqual(
      listTasks({ status: "pending", tag: "worktree:feat-a" }).map((t) => t.id),
      [a.id],
    );
    assert.equal(nextTask({ tag: "worktree:feat-a" })?.id, a.id); // distinguishing: tag-blind would give b
    assert.equal(nextTask({ tag: "worktree:feat-b" })?.id, b.id);
  });

  it("the tag match is exact — worktree:feat-a does not match worktree:feat-a-2 (no prefix bleed)", () => {
    // The catching direction: querying the SHORTER tag must NOT pull the longer-named worktree's task
    // (a substring/prefix filter would wrongly include a2 here).
    assert.ok(!listTasks({ status: "pending", tag: "worktree:feat-a" }).some((t) => t.id === a2.id));
  });

  it("an UNTAGGED worker pulls pinned tasks too (the caveat: tag every puller on a shared board)", () => {
    // No tag filter = every pending task is eligible, INCLUDING worktree-pinned ones. This is why a
    // shared board must not run an untagged worker (or `get_next_task`/`bob next`/`/bob-work` with no
    // tag) beside the per-worktree ones.
    const ids = new Set(listTasks({ status: "pending" }).map((t) => t.id));
    for (const t of [a, b, a2]) assert.ok(ids.has(t.id), `untagged pull should see #${t.id} regardless of tag`);
  });

  it("startup reclaim is tag-scoped: one worktree worker can't re-queue another's in-flight task", () => {
    // Two workers as the same default assignee 'bob' but distinct --tag. Reclaiming rec-a's slice must
    // leave rec-b's in-flight task untouched (else a sibling worker's startup corrupts a running task).
    const ra = createTask({ title: "rec-a", tags: ["worktree:rec-a"] });
    const rb = createTask({ title: "rec-b", tags: ["worktree:rec-b"] });
    assert.ok(claimTask(ra.id, "bob") && claimTask(rb.id, "bob")); // both in_progress as 'bob'
    const n = reclaimStaleInProgress("bob", "worktree:rec-a");
    assert.equal(n, 1, "only the rec-a slice is reclaimed");
    assert.equal(getTask(ra.id)?.status, "pending"); // re-queued
    assert.equal(getTask(rb.id)?.status, "in_progress"); // the other worktree's task is untouched
  });
});
