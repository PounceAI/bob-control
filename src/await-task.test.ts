import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, createTask, claimTask, updateStatus, getTaskStatus, askQuestion } from "./db.js";
import { completeTask } from "./completion.js";
import { awaitTaskOutcome } from "./await-task.js";

const DB = join(tmpdir(), "bob-test-await-task.db");
function clean(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// awaitTaskOutcome is the await_task poll primitive: it classifies a task's board state into the
// outcome the MCP handler renders (a thin switch over the union). These exercise every branch
// directly, across the real lifecycle a dispatched task moves through — so the handler's response
// shape can't silently regress.
describe("awaitTaskOutcome (await_task poll classification)", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("missing: an unknown task id classifies as missing (handler → fail)", () => {
    assert.deepEqual(awaitTaskOutcome(999_999), { kind: "missing" });
    assert.equal(getTaskStatus(999_999), null);
  });

  it("unsettled: pending then in_progress keep the awaiter waiting", () => {
    const t = createTask({ title: "ship it" });
    assert.deepEqual(awaitTaskOutcome(t.id), { kind: "unsettled", status: "pending" });
    claimTask(t.id, "worker");
    assert.deepEqual(awaitTaskOutcome(t.id), { kind: "unsettled", status: "in_progress" });
  });

  it("settled: an implementation run with evidence resolves to done + result", () => {
    const t = createTask({ title: "build feature" });
    claimTask(t.id, "worker");
    completeTask(t.id, { result: "added the endpoint", ranReadOnly: false, evidence: { files_changed: 2 } });
    assert.deepEqual(awaitTaskOutcome(t.id), { kind: "settled", status: "done", result: "added the endpoint" });
  });

  it("settled: a read-only run resolves to analysis_done (carrying its result)", () => {
    const t = createTask({ title: "review the diff" });
    claimTask(t.id, "worker");
    completeTask(t.id, { result: "found 3 issues", ranReadOnly: true });
    assert.deepEqual(awaitTaskOutcome(t.id), { kind: "settled", status: "analysis_done", result: "found 3 issues" });
  });

  it("settled: blocked and cancelled both resolve (Bob stopped without completing)", () => {
    const b = createTask({ title: "stuck" });
    claimTask(b.id, "worker");
    updateStatus(b.id, "blocked");
    assert.deepEqual(awaitTaskOutcome(b.id), { kind: "settled", status: "blocked", result: null });

    const c = createTask({ title: "dropped" });
    updateStatus(c.id, "cancelled");
    assert.deepEqual(awaitTaskOutcome(c.id), { kind: "settled", status: "cancelled", result: null });
  });

  it("needs_input: surfaces the open question (id + text + options) so the caller can answer", () => {
    const t = createTask({ title: "needs a decision" });
    claimTask(t.id, "worker");
    const q = askQuestion(t.id, "Which region?", ["us-east", "eu-west"])!;
    assert.deepEqual(awaitTaskOutcome(t.id), {
      kind: "needs_input",
      question: { question_id: q.question_id, text: "Which region?", options: ["us-east", "eu-west"] },
    });
  });

  it("getTaskStatus reads only status + result (the poll hot path)", () => {
    const t = createTask({ title: "snapshot" });
    assert.deepEqual(getTaskStatus(t.id), { status: "pending", result: null });
  });
});
