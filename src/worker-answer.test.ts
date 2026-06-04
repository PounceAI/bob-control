import { test } from "node:test";
import assert from "node:assert/strict";
import { handleStdinAnswer, type AnswerableGate } from "./worker-answer.js";

// Tests the REAL handleStdinAnswer (imported), not a copy.
function fakeGate(): AnswerableGate & { answers: string[] } {
  const answers: string[] = [];
  return { answerHuman: (a) => answers.push(a), answers };
}

test("routes a valid answer to the matching task's gate only", () => {
  const g7 = fakeGate();
  const g9 = fakeGate();
  const gates = new Map([
    [7, g7],
    [9, g9],
  ]);
  const logs: string[] = [];
  handleStdinAnswer(JSON.stringify({ taskId: 7, answer: "src/config.ts" }), gates, (m) => logs.push(m));
  assert.deepEqual(g7.answers, ["src/config.ts"]);
  assert.equal(g9.answers.length, 0, "other gate untouched");
  assert.equal(logs.length, 0, "no error logs");
});

test("malformed JSON logs and routes nothing", () => {
  const logs: string[] = [];
  handleStdinAnswer("not json", new Map(), (m) => logs.push(m));
  assert.match(logs[0], /malformed.*not JSON/);
});

test("missing/wrong-typed taskId or answer logs and routes nothing", () => {
  const g7 = fakeGate();
  const gates = new Map([[7, g7]]);
  for (const bad of [{ answer: "y" }, { taskId: 7 }, { taskId: "7", answer: "y" }, { taskId: 7, answer: 123 }]) {
    const logs: string[] = [];
    handleStdinAnswer(JSON.stringify(bad), gates, (m) => logs.push(m));
    assert.match(logs[0], /missing taskId or answer/, JSON.stringify(bad));
  }
  assert.equal(g7.answers.length, 0);
});

test("answer for an unknown/closed task logs, doesn't throw", () => {
  const g7 = fakeGate();
  const gates = new Map([[7, g7]]);
  const logs: string[] = [];
  handleStdinAnswer(JSON.stringify({ taskId: 99, answer: "yes" }), gates, (m) => logs.push(m));
  assert.equal(g7.answers.length, 0);
  assert.match(logs[0], /task #99 but no active gate/);
});

test("an empty-string answer is passed through (the gate decides validity)", () => {
  const g7 = fakeGate();
  const gates = new Map([[7, g7]]);
  const logs: string[] = [];
  handleStdinAnswer(JSON.stringify({ taskId: 7, answer: "" }), gates, (m) => logs.push(m));
  assert.deepEqual(g7.answers, [""]);
  assert.equal(logs.length, 0);
});

test("multiline answers survive intact", () => {
  const g7 = fakeGate();
  const gates = new Map([[7, g7]]);
  const multiline = "Line 1\nLine 2\nLine 3";
  handleStdinAnswer(JSON.stringify({ taskId: 7, answer: multiline }), gates, () => {});
  assert.deepEqual(g7.answers, [multiline]);
});
