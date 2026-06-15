import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDb,
  createTask,
  claimTask,
  updateStatus,
  getTask,
  getNotes,
  addNote,
  askQuestion,
  getOpenQuestion,
  listOpenQuestions,
  answerQuestion,
  getQuestion,
  questionState,
  expireOverdueQuestions,
  closeOpenQuestions,
  completeTask,
} from "./db.js";
import { buildReport } from "./report.js";

const DB = join(tmpdir(), "bob-test-questions.db");
function clean(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** A task in the state a worker raises a question from: claimed → in_progress. */
function workedTask(title: string): number {
  const t = createTask({ title });
  claimTask(t.id, "worker");
  return t.id;
}

describe("board question round-trip (needs_input)", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("ask_question parks the task needs_input and exposes the question (text + options + id)", () => {
    const id = workedTask("scale the service");
    const q = askQuestion(id, "Which gunicorn worker count?", ["2", "4", "8"]);
    assert.ok(q);
    assert.equal(getTask(id)?.status, "needs_input");

    const open = getOpenQuestion(id);
    assert.equal(open?.question_id, q!.question_id);
    assert.equal(open?.text, "Which gunicorn worker count?");
    assert.deepEqual(open?.options, ["2", "4", "8"]);
    assert.ok(getNotes(id).some((n) => /Which gunicorn worker count/.test(n.note)));
  });

  it("askQuestion REQUIRES a task being worked (rejects pending/terminal)", () => {
    const pending = createTask({ title: "not claimed" });
    assert.equal(askQuestion(pending.id, "q?"), null); // pending → refused
    const fin = createTask({ title: "finished" });
    updateStatus(fin.id, "done");
    assert.equal(askQuestion(fin.id, "q?"), null); // done → refused
  });

  it("board_report shows the OPEN QUESTION (not just the last note) with wait time", () => {
    const id = workedTask("needs a decision");
    askQuestion(id, "Deploy timeline?");
    addNote(id, "checking with ops", "claude"); // a later note must NOT hide the question
    const task = getTask(id)!;
    const notes = new Map([[id, getNotes(id)]]);
    const open = getOpenQuestion(id)!;
    const openQuestions = new Map([[id, { text: open.text, options: open.options }]]);
    const md = buildReport([task], notes, Date.parse(task.updated_at) + 5000, { openQuestions });
    assert.match(md, /Awaiting answer \(1\)/);
    assert.match(md, /Deploy timeline\?/); // the question, surfaced
    assert.doesNotMatch(md, /checking with ops/); // the later note did NOT shadow it
    assert.match(md, /idle 5s/);
  });

  it("answer_task_question records the answer, matched by id, and resumes the worker (in_progress)", () => {
    const id = workedTask("ask then answer");
    const q = askQuestion(id, "max_connections / pool size?")!;
    const res = answerQuestion(id, q.question_id, "pool=20 (from PG max_connections=70)");
    assert.ok(res.ok);
    assert.equal(getTask(id)?.status, "in_progress");
    assert.equal(getQuestion(q.question_id)?.status, "answered");
    assert.equal(getQuestion(q.question_id)?.answer, "pool=20 (from PG max_connections=70)");
    assert.equal(getOpenQuestion(id), null);
    assert.ok(getNotes(id).some((n) => n.author === "human" && /Answered/.test(n.note)));
  });

  it("await_answer poll signal: state goes open → answered", () => {
    const id = workedTask("poll");
    const q = askQuestion(id, "go?")!;
    assert.equal(questionState(q.question_id).status, "open");
    answerQuestion(id, q.question_id, "go");
    assert.deepEqual(questionState(q.question_id), { status: "answered", answer: "go" });
  });

  it("a mismatched / unknown question_id is rejected (stale answer can't apply)", () => {
    const id = workedTask("correlation");
    const q = askQuestion(id, "real question?")!;
    assert.equal(answerQuestion(id, "not-the-id", "x").ok, false);
    const other = workedTask("other");
    assert.equal(answerQuestion(other, q.question_id, "x").ok, false); // right id, wrong task
    assert.equal(getOpenQuestion(id)?.question_id, q.question_id); // still open
  });

  it("answering twice is idempotent (first answer stands)", () => {
    const id = workedTask("idempotent");
    const q = askQuestion(id, "once?")!;
    assert.ok(answerQuestion(id, q.question_id, "first").ok);
    assert.ok(answerQuestion(id, q.question_id, "second").ok);
    assert.equal(getQuestion(q.question_id)?.answer, "first");
  });

  it("completing a task CLOSES its open question (settle closes pending_question)", () => {
    const id = workedTask("complete-closes-question");
    const q = askQuestion(id, "which approach?")!;
    assert.equal(getOpenQuestion(id)?.question_id, q.question_id);
    completeTask(id, { result: "analysis text", ranReadOnly: true }); // run finished
    assert.equal(getTask(id)?.status, "analysis_done");
    assert.equal(getOpenQuestion(id), null); // no longer open
    assert.equal(getQuestion(q.question_id)?.status, "timed_out"); // closed (superseded)
  });

  it("a late answer to a SETTLED task is alreadyAnswered and does NOT re-dispatch", () => {
    // stall → run completes out-of-band (answer-via-A) → answer the SAME qid via the board
    // (answer-via-B): must report alreadyAnswered and leave the task settled (no second run).
    const id = workedTask("no-double-run");
    const q = askQuestion(id, "proceed?")!;
    completeTask(id, { result: "review output (the one legitimate run)", ranReadOnly: true });
    assert.equal(getTask(id)?.status, "analysis_done");

    const res = answerQuestion(id, q.question_id, "proceed (late, via foreman/MCP)");
    assert.deepEqual(res, { ok: true, alreadyAnswered: true }); // <-- not {alreadyAnswered:false}
    assert.equal(getTask(id)?.status, "analysis_done"); // NOT resumed to in_progress → no re-dispatch
  });

  it("a late answer to a CANCELLED task is a no-op (guard fires even if the question stayed open)", () => {
    const id = workedTask("answer-after-cancel");
    const q = askQuestion(id, "still want this?")!;
    updateStatus(id, "cancelled"); // low-level cancel: leaves the question open
    assert.equal(getOpenQuestion(id)?.question_id, q.question_id); // still open here
    const res = answerQuestion(id, q.question_id, "yes");
    assert.deepEqual(res, { ok: true, alreadyAnswered: true });
    assert.equal(getTask(id)?.status, "cancelled"); // not resurrected
    assert.equal(getQuestion(q.question_id)?.status, "timed_out"); // guard closed it
  });

  it("closeOpenQuestions supersedes only OPEN questions and is idempotent", () => {
    const id = workedTask("close-open");
    const q = askQuestion(id, "open one?")!;
    assert.equal(closeOpenQuestions(id, "test"), 1); // closed the open one
    assert.equal(getQuestion(q.question_id)?.status, "timed_out");
    assert.equal(closeOpenQuestions(id, "again"), 0); // nothing open → no-op
  });

  it("asking again SUPERSEDES the prior open question (one open per task)", () => {
    const id = workedTask("supersede");
    const q1 = askQuestion(id, "Q1?")!;
    const q2 = askQuestion(id, "Q2?")!;
    assert.notEqual(q1.question_id, q2.question_id);
    assert.equal(getQuestion(q1.question_id)?.status, "timed_out"); // closed
    assert.equal(getOpenQuestion(id)?.question_id, q2.question_id); // only Q2 open
    assert.equal(listOpenQuestions().filter((q) => q.task_id === id).length, 1);
  });

  it("race: an ANSWER beats a late timeout poll (answer wins, task not blocked)", () => {
    const id = workedTask("answer-wins");
    const q = askQuestion(id, "race?", [], 60_000)!;
    answerQuestion(id, q.question_id, "done"); // answered while still open
    // A poll past the deadline must NOT overwrite the recorded answer.
    const st = questionState(q.question_id, Date.parse(q.deadline_at) + 1);
    assert.deepEqual(st, { status: "answered", answer: "done" });
    assert.equal(getTask(id)?.status, "in_progress"); // not blocked
  });

  it("race: a TIMEOUT closes the question; a late answer is then rejected (fail-safe)", () => {
    const id = workedTask("timeout-wins");
    const q = askQuestion(id, "stakeholders?", [], 60_000)!;
    const st = questionState(q.question_id, Date.parse(q.deadline_at) + 1);
    assert.equal(st.status, "timed_out");
    assert.equal(getTask(id)?.status, "blocked"); // parked, NOT done
    assert.equal(getQuestion(q.question_id)?.answer, null); // never fabricated
    assert.equal(answerQuestion(id, q.question_id, "too late").ok, false);
    assert.ok(getNotes(id).some((n) => /unanswered past timeout/i.test(n.note)));
  });

  it("the sweeper expires overdue questions even if nobody polls them", () => {
    const id = workedTask("sweep");
    const q = askQuestion(id, "deadline?", [], 1)!; // ~1ms deadline
    const n = expireOverdueQuestions(Date.parse(q.deadline_at) + 1000);
    assert.ok(n >= 1);
    assert.equal(getQuestion(q.question_id)?.status, "timed_out");
    assert.equal(getTask(id)?.status, "blocked"); // fail-safe fired without any await_answer poll
  });

  it("a huge timeout_ms is clamped, not allowed to overflow the Date (no throw)", () => {
    const id = workedTask("clamp");
    const q = askQuestion(id, "x", [], Number.MAX_SAFE_INTEGER);
    assert.ok(q);
    assert.ok(Number.isFinite(Date.parse(q!.deadline_at))); // valid ISO, not Invalid Date
  });

  it("listOpenQuestions surfaces only still-open questions", () => {
    const before = listOpenQuestions().length;
    const id = workedTask("list");
    const q = askQuestion(id, "open one?")!;
    assert.equal(listOpenQuestions().length, before + 1);
    answerQuestion(id, q.question_id, "done");
    assert.equal(listOpenQuestions().length, before);
  });
});
