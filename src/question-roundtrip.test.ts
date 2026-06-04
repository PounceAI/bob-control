import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDb,
  createTask,
  getTask,
  getNotes,
  askQuestion,
  getOpenQuestion,
  listOpenQuestions,
  answerQuestion,
  getQuestion,
  questionState,
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

describe("board question round-trip (needs_input)", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("ask_question parks the task needs_input and exposes the question (text + options + id)", () => {
    const t = createTask({ title: "scale the service" });
    const q = askQuestion(t.id, "Which gunicorn worker count?", ["2", "4", "8"]);
    assert.ok(q);
    assert.equal(getTask(t.id)?.status, "needs_input");

    const open = getOpenQuestion(t.id);
    assert.equal(open?.question_id, q!.question_id);
    assert.equal(open?.text, "Which gunicorn worker count?");
    assert.deepEqual(open?.options, ["2", "4", "8"]);
    // The question text is on the board as a note, too.
    assert.ok(getNotes(t.id).some((n) => /Which gunicorn worker count/.test(n.note)));
  });

  it("board_report lists the task under '❓ Awaiting answer' with the question and a wait time", () => {
    const t = createTask({ title: "needs a decision" });
    askQuestion(t.id, "Deploy timeline?");
    const task = getTask(t.id)!;
    const notes = new Map([[t.id, getNotes(t.id)]]);
    const md = buildReport([task], notes, Date.parse(task.updated_at) + 5000);
    assert.match(md, /Awaiting answer \(1\)/);
    assert.match(md, /Deploy timeline\?/);
    assert.match(md, /idle 5s/); // wait time surfaced
  });

  it("answer_task_question records the answer, matched by id, and resumes the worker (in_progress)", () => {
    const t = createTask({ title: "ask then answer" });
    const q = askQuestion(t.id, "max_connections / pool size?")!;
    const res = answerQuestion(t.id, q.question_id, "pool=20 (from PG max_connections=70)");
    assert.ok(res.ok);
    assert.equal(getTask(t.id)?.status, "in_progress"); // worker resumes
    assert.equal(getQuestion(q.question_id)?.status, "answered");
    assert.equal(getQuestion(q.question_id)?.answer, "pool=20 (from PG max_connections=70)");
    assert.equal(getOpenQuestion(t.id), null); // no longer open
    assert.ok(getNotes(t.id).some((n) => n.author === "human" && /Answered/.test(n.note)));
  });

  it("await_answer's poll signal: state goes open → answered", () => {
    const t = createTask({ title: "poll" });
    const q = askQuestion(t.id, "go?")!;
    assert.equal(questionState(q.question_id).status, "open");
    answerQuestion(t.id, q.question_id, "go");
    assert.deepEqual(questionState(q.question_id), { status: "answered", answer: "go" });
  });

  it("a mismatched / unknown question_id is rejected (stale answer can't apply)", () => {
    const t = createTask({ title: "correlation" });
    const q = askQuestion(t.id, "real question?")!;
    assert.equal(answerQuestion(t.id, "not-the-id", "x").ok, false);
    // right id but wrong task is rejected too
    const other = createTask({ title: "other" });
    assert.equal(answerQuestion(other.id, q.question_id, "x").ok, false);
    // the real question is still open and unanswered
    assert.equal(getOpenQuestion(t.id)?.question_id, q.question_id);
  });

  it("answering twice is idempotent (no error, no double-apply)", () => {
    const t = createTask({ title: "idempotent" });
    const q = askQuestion(t.id, "once?")!;
    assert.ok(answerQuestion(t.id, q.question_id, "first").ok);
    const again = answerQuestion(t.id, q.question_id, "second");
    assert.ok(again.ok);
    assert.equal(getQuestion(q.question_id)?.answer, "first"); // first answer stands
  });

  it("an unanswered question past its deadline times out and FAILS SAFE (task blocked, no answer)", () => {
    const t = createTask({ title: "timeout" });
    const q = askQuestion(t.id, "stakeholders?", [], 60_000)!;
    // Poll with a clock past the deadline.
    const st = questionState(q.question_id, Date.parse(q.deadline_at) + 1);
    assert.equal(st.status, "timed_out");
    assert.equal(getTask(t.id)?.status, "blocked"); // parked, NOT done
    assert.equal(getQuestion(q.question_id)?.answer, null); // never fabricated
    assert.ok(getNotes(t.id).some((n) => /unanswered past timeout/i.test(n.note)));
    // A late answer to a timed-out question is rejected.
    assert.equal(answerQuestion(t.id, q.question_id, "too late").ok, false);
  });

  it("listOpenQuestions surfaces only still-open questions", () => {
    const before = listOpenQuestions().length;
    const t = createTask({ title: "list" });
    const q = askQuestion(t.id, "open one?")!;
    assert.equal(listOpenQuestions().length, before + 1);
    answerQuestion(t.id, q.question_id, "done");
    assert.equal(listOpenQuestions().length, before);
  });
});
