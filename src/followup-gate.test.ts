import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollowupGate, parseFollowup, type FollowupGateDeps, type FollowupEvent } from "./followup-gate.js";
import type { FollowupAnswer } from "./answer.js";

function harness(over: Partial<FollowupGateDeps> = {}, result: FollowupAnswer = { answer: "Create both", reason: "ok" }) {
  const sent: string[] = [];
  const escalations: Array<{ question: string; options: string[] }> = [];
  const logs: string[] = [];
  const notes: Array<{ note: string; author?: string }> = [];
  const answerArgs: any[] = [];
  const gate = createFollowupGate({
    enabled: true,
    blocked: false,
    escalateAll: false,
    backend: "cli",
    task: { id: 7, title: "build the report" },
    cwd: "/repo",
    client: { sendMessage: (t) => sent.push(t) },
    addNote: (_id, note, author) => notes.push({ note, author }),
    log: (m) => logs.push(m),
    escalate: (question, options) => escalations.push({ question, options }),
    answer: (async (question, options, ctx, deps) => {
      answerArgs.push({ question, options, ctx, deps });
      return result;
    }) as FollowupGateDeps["answer"],
    ...over,
  });
  return { gate, sent, escalations, logs, notes, answerArgs };
}

const followup = (question: string, suggest: string[] = []): FollowupEvent => ({
  ask: "followup",
  text: JSON.stringify({ question, suggest: suggest.map((answer) => ({ answer })) }),
});

// --- parseFollowup ---

test("parseFollowup extracts question + suggested option text", () => {
  const p = parseFollowup(JSON.stringify({ question: "Wait or create?", suggest: [{ answer: "Wait" }, { answer: "Create" }] }));
  assert.deepEqual(p, { question: "Wait or create?", options: ["Wait", "Create"] });
});

test("parseFollowup falls back to plain text and returns null when empty", () => {
  assert.deepEqual(parseFollowup("just a question?"), { question: "just a question?", options: [] });
  assert.equal(parseFollowup("   "), null);
  assert.equal(parseFollowup(JSON.stringify({ question: "" })), null);
});

// --- gate behavior ---

test("a confident answer is sent back over IPC and noted", async () => {
  const h = harness({}, { answer: "Create both", reason: "clear" });
  await h.gate(followup("Wait or create?", ["Wait", "Create both"]));
  assert.deepEqual(h.sent, ["Create both"]);
  assert.equal(h.escalations.length, 0);
  assert.equal(h.answerArgs[0].options.length, 2);
  assert.match(h.notes.at(-1)!.note, /Answered .* → "Create both"/);
  assert.equal(h.notes.at(-1)!.author, "answerer");
});

test("a declined answer escalates to a human instead of sending", async () => {
  const h = harness({}, { answer: null, reason: "deletes data" });
  await h.gate(followup("Should I delete the table?"));
  assert.deepEqual(h.sent, []);
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0].question, /delete the table/);
  assert.match(h.logs.join("\n"), /escalated/);
});

test("forwards task title and cwd as answer context", async () => {
  const h = harness();
  await h.gate(followup("q"));
  assert.deepEqual(h.answerArgs[0].ctx, { task: "build the report", cwd: "/repo" });
});

test("dedups a repeated question (answers once)", async () => {
  const h = harness();
  await h.gate(followup("same?"));
  await h.gate(followup("same?"));
  assert.equal(h.answerArgs.length, 1);
  assert.equal(h.sent.length, 1);
});

test("ignores non-followup asks, partials, and disabled gate", async () => {
  const h = harness();
  await h.gate({ ask: "command", text: "rm -rf /" });
  await h.gate({ ask: "followup", text: JSON.stringify({ question: "q" }), partial: true });
  assert.equal(h.answerArgs.length, 0);

  const off = harness({ enabled: false });
  await off.gate(followup("q"));
  assert.equal(off.answerArgs.length, 0);
});

test("blocked (api, no key) escalates and warns exactly once", async () => {
  const h = harness({ blocked: true, backend: "api" });
  await h.gate(followup("q1"));
  await h.gate(followup("q2"));
  assert.equal(h.answerArgs.length, 0, "never calls the answerer");
  assert.equal(h.escalations.length, 2, "both escalate");
  assert.equal(h.logs.filter((l) => /ANTHROPIC_API_KEY unset/.test(l)).length, 1);
});

test("a verdict that lands after the dispatch ends is not sent", async () => {
  let active = true;
  const h = harness({ isActive: () => active }, { answer: "Create both", reason: "ok" });
  const pending = h.gate(followup("q"));
  active = false;
  await pending;
  assert.deepEqual(h.sent, [], "must not answer a settled dispatch");
});

test("escalate-all mode escalates every question instead of answering", async () => {
  const h = harness({ escalateAll: true }, { answer: "Create both", reason: "ok" });
  await h.gate(followup("Wait or create?", ["Wait", "Create both"]));
  assert.deepEqual(h.sent, [], "must not send an answer");
  assert.equal(h.escalations.length, 1, "must escalate");
  assert.match(h.escalations[0].question, /Wait or create/);
  assert.equal(h.answerArgs.length, 0, "must not call the answerer");
  assert.match(h.logs.join("\n"), /escalated.*--escalate-all/);
  assert.match(h.notes.at(-1)!.note, /escalated.*--escalate-all/);
});

test("escalate-all off = unchanged behavior (answers confident questions)", async () => {
  const h = harness({ escalateAll: false }, { answer: "Create both", reason: "ok" });
  await h.gate(followup("Wait or create?", ["Wait", "Create both"]));
  assert.deepEqual(h.sent, ["Create both"], "must answer");
  assert.equal(h.escalations.length, 0, "must not escalate");
  assert.equal(h.answerArgs.length, 1, "must call the answerer");
});

test("escalate-all takes precedence over answerer confidence", async () => {
  // Even when the answerer would be confident, escalate-all forces escalation.
  const h = harness({ escalateAll: true }, { answer: "Yes", reason: "clear" });
  await h.gate(followup("Should I proceed?"));
  assert.deepEqual(h.sent, []);
  assert.equal(h.escalations.length, 1);
  assert.equal(h.answerArgs.length, 0, "answerer never consulted");
});
