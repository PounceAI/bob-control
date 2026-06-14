import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFollowupGate,
  parseFollowup,
  buildIdleAskQuestion,
  followupDisposition,
  type FollowupGateDeps,
  type FollowupEvent,
} from "./followup-gate.js";
import type { FollowupAnswer } from "./answer.js";

function harness(
  over: Partial<FollowupGateDeps> = {},
  result: FollowupAnswer = { answer: "Create both", reason: "ok" },
) {
  const sent: string[] = [];
  const escalations: Array<{ question: string; options: string[] }> = [];
  const logs: string[] = [];
  const notes: Array<{ note: string; author?: string }> = [];
  const answerArgs: any[] = [];
  const gateObj = createFollowupGate({
    enabled: true,
    blocked: false,
    escalateAll: false,
    reviewPlans: false,
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
  return {
    gate: gateObj.gate,
    answerHuman: gateObj.answerHuman,
    getPending: gateObj.getPending,
    sent,
    escalations,
    logs,
    notes,
    answerArgs,
  };
}

const followup = (question: string, suggest: string[] = []): FollowupEvent => ({
  ask: "followup",
  text: JSON.stringify({ question, suggest: suggest.map((answer) => ({ answer })) }),
});

// --- parseFollowup ---

test("parseFollowup extracts question + suggested option text", () => {
  const p = parseFollowup(
    JSON.stringify({ question: "Wait or create?", suggest: [{ answer: "Wait" }, { answer: "Create" }] }),
  );
  assert.deepEqual(p, { question: "Wait or create?", options: ["Wait", "Create"] });
});

test("parseFollowup falls back to plain text and returns null when empty", () => {
  assert.deepEqual(parseFollowup("just a question?"), { question: "just a question?", options: [] });
  assert.equal(parseFollowup("   "), null);
  assert.equal(parseFollowup(JSON.stringify({ question: "" })), null);
});

// --- buildIdleAskQuestion (idle-recovery board question) ---

test("buildIdleAskQuestion parses a followup JSON into a clean question + options", () => {
  const q = buildIdleAskQuestion({
    askKind: "followup",
    rawAskText: JSON.stringify({
      question: "Are these the complete implementations, or are there more files?",
      suggest: [{ answer: "Complete" }, { answer: "More files" }],
    }),
  });
  assert.match(q, /Bob stalled on a 'followup' prompt/);
  assert.match(q, /Are these the complete implementations/);
  assert.match(q, /\[options: Complete \| More files\]/);
  assert.match(q, /re-run/);
  // The raw JSON braces must not leak into the surfaced question.
  assert.doesNotMatch(q, /"suggest"/);
});

test("buildIdleAskQuestion surfaces a non-followup ask (command) as plain text", () => {
  const q = buildIdleAskQuestion({ askKind: "command", rawAskText: "rm -rf build", branch: "bob/task-46" });
  assert.match(q, /Bob stalled on a 'command' prompt/);
  assert.match(q, /rm -rf build/);
  assert.match(q, /Partial work saved to branch bob\/task-46\./);
});

test("buildIdleAskQuestion handles a plain-text followup and omits an empty branch note", () => {
  const q = buildIdleAskQuestion({ askKind: "followup", rawAskText: "just a question?" });
  assert.match(q, /just a question\?/);
  assert.doesNotMatch(q, /Partial work saved/);
});

// --- followupDisposition (shared escalate-vs-answer policy) ---

const DISP = { enabled: true, blocked: false, reviewPlans: false, escalateAll: false };

test("followupDisposition: disabled gate is 'off'", () => {
  assert.equal(followupDisposition({ ...DISP, enabled: false }, "anything?"), "off");
});

test("followupDisposition: no API key (blocked) always escalates, even a mechanical question", () => {
  assert.equal(followupDisposition({ ...DISP, blocked: true }, "which file path should I use?"), "escalate");
});

test("followupDisposition: default (no flags) auto-answers", () => {
  assert.equal(followupDisposition(DISP, "Should I refactor the auth module?"), "answer");
});

test("followupDisposition: --review-plans escalates plan questions, answers mechanical ones", () => {
  const rp = { ...DISP, reviewPlans: true };
  assert.equal(followupDisposition(rp, "Should I proceed with deleting the table?"), "escalate");
  assert.equal(followupDisposition(rp, "which file path should I use?"), "answer");
});

test("followupDisposition: --escalate-all escalates everything", () => {
  assert.equal(followupDisposition({ ...DISP, escalateAll: true }, "which file path should I use?"), "escalate");
});

test("followupDisposition: --review-plans takes precedence over --escalate-all for mechanical questions", () => {
  assert.equal(
    followupDisposition({ ...DISP, reviewPlans: true, escalateAll: true }, "which file path should I use?"),
    "answer",
  );
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

// --- classifyQuestion ---

test("classifyQuestion: plan/design approval questions are classified as plan", async () => {
  const { classifyQuestion } = await import("./followup-gate.js");

  assert.equal(classifyQuestion("Should I proceed with this approach?"), "plan");
  assert.equal(classifyQuestion("Do you want me to refactor the entire module?"), "plan");
  assert.equal(classifyQuestion("Is this okay to delete the table?"), "plan");
  assert.equal(classifyQuestion("Which approach should I take: A or B?"), "plan");
  assert.equal(classifyQuestion("Can I proceed with the breaking change?"), "plan");
  assert.equal(classifyQuestion("Would you like me to modify the API?"), "plan");
  assert.equal(classifyQuestion("How should I restructure this?"), "plan");
  assert.equal(classifyQuestion("What design pattern is better to use here?"), "plan");
  assert.equal(classifyQuestion("May I change the behavior of this function?"), "plan");
  assert.equal(classifyQuestion("Shall I drop the database?"), "plan");
});

test("classifyQuestion: mechanical clarifications are classified as mechanical", async () => {
  const { classifyQuestion } = await import("./followup-gate.js");

  assert.equal(classifyQuestion("Which file should I edit?"), "mechanical");
  assert.equal(classifyQuestion("What is the path to the config file?"), "mechanical");
  assert.equal(classifyQuestion("Where should I put this function?"), "mechanical");
  assert.equal(classifyQuestion("Which flag name: -x or -y?"), "mechanical");
  assert.equal(classifyQuestion("What is the directory name?"), "mechanical");
  assert.equal(classifyQuestion("File path for the new module?"), "mechanical");
  assert.equal(classifyQuestion("Should I use single or double quotes?"), "mechanical");
  assert.equal(classifyQuestion("Which option: option A or option B?"), "mechanical");
  assert.equal(classifyQuestion("What format should I use?"), "mechanical");
  assert.equal(classifyQuestion("Which file extension to use?"), "mechanical");
});

test("classifyQuestion: ambiguous questions default to plan (conservative)", async () => {
  const { classifyQuestion } = await import("./followup-gate.js");

  assert.equal(classifyQuestion("What should I do next?"), "plan");
  assert.equal(classifyQuestion("How do you want this implemented?"), "plan");
  assert.equal(classifyQuestion("Is this the right way?"), "plan");
  assert.equal(classifyQuestion("Any preferences?"), "plan");
});

// --- reviewPlans policy ---

test("reviewPlans mode: plan questions escalate, mechanical ones auto-answer", async () => {
  const planResult = { answer: "Proceed", reason: "clear" };
  const mechanicalResult = { answer: "src/config.ts", reason: "clear" };
  let answerCallCount = 0;

  const sent: string[] = [];
  const escalations: Array<{ question: string; options: string[] }> = [];
  const logs: string[] = [];
  const notes: Array<{ note: string; author?: string }> = [];
  const answerArgs: any[] = [];

  const gateObj = createFollowupGate({
    enabled: true,
    blocked: false,
    escalateAll: false,
    reviewPlans: true,
    backend: "cli",
    task: { id: 7, title: "build the report" },
    cwd: "/repo",
    client: { sendMessage: (t) => sent.push(t) },
    addNote: (_id, note, author) => notes.push({ note, author }),
    log: (m) => logs.push(m),
    escalate: (question, options) => escalations.push({ question, options }),
    answer: (async (question: string, options: string[], ctx: any, deps: any) => {
      answerCallCount++;
      answerArgs.push({ question, options, ctx, deps });
      // Return different results based on question type
      return question.includes("file") ? mechanicalResult : planResult;
    }) as FollowupGateDeps["answer"],
  });
  const h = {
    gate: gateObj.gate,
    answerHuman: gateObj.answerHuman,
    getPending: gateObj.getPending,
    sent,
    escalations,
    logs,
    notes,
    answerArgs,
  };

  // Plan question should escalate
  await h.gate(followup("Should I proceed with this refactor?"));
  assert.equal(h.escalations.length, 1, "plan question must escalate");
  assert.match(h.escalations[0].question, /refactor/);
  assert.equal(h.sent.length, 0, "plan question must not be auto-answered");
  assert.equal(answerCallCount, 0, "answerer not called for plan question");
  assert.match(h.logs.join("\n"), /plan\/design question.*--review-plans/);

  // Mechanical question should auto-answer
  await h.gate(followup("Which file should I edit?"));
  assert.equal(h.escalations.length, 1, "mechanical question must not escalate");
  assert.equal(h.sent.length, 1, "mechanical question must be answered");
  assert.equal(h.sent[0], "src/config.ts");
  assert.equal(answerCallCount, 1, "answerer called for mechanical question");
  assert.match(h.logs.join("\n"), /answering mechanical followup.*--review-plans/);
});

test("reviewPlans takes precedence over escalateAll when both are on", async () => {
  const h = harness({ reviewPlans: true, escalateAll: true }, { answer: "src/config.ts", reason: "clear" });

  // Plan question escalates (reviewPlans behavior)
  await h.gate(followup("Should I delete the database?"));
  assert.equal(h.escalations.length, 1);
  assert.equal(h.sent.length, 0);
  assert.match(h.logs.join("\n"), /plan\/design question.*--review-plans/);

  // Mechanical question auto-answers (reviewPlans behavior, NOT escalateAll)
  await h.gate(followup("Which file path?"));
  assert.equal(h.escalations.length, 1, "still only one escalation");
  assert.equal(h.sent.length, 1, "mechanical answered despite escalateAll");
  assert.equal(h.answerArgs.length, 1);
});

test("reviewPlans off = unchanged behavior (respects escalateAll)", async () => {
  const h = harness({ reviewPlans: false, escalateAll: true }, { answer: "Yes", reason: "clear" });

  // With escalateAll and reviewPlans off, ALL questions escalate
  await h.gate(followup("Which file?"));
  assert.equal(h.escalations.length, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.answerArgs.length, 0);
  assert.match(h.logs.join("\n"), /--escalate-all/);
});

test("reviewPlans: declined mechanical answer still escalates", async () => {
  const h = harness({ reviewPlans: true }, { answer: null, reason: "unsure" });

  // Even though it's mechanical, if answerer declines, it escalates
  await h.gate(followup("Which file path?"));
  assert.equal(h.escalations.length, 1);
  assert.equal(h.sent.length, 0);
  assert.match(h.logs.join("\n"), /answering mechanical/);
  assert.match(h.logs.join("\n"), /escalated.*unsure/);
});

// --- human answer routing ---

test("answerHuman sends the answer via sendMessage when dispatch is active", async () => {
  const h = harness();
  await h.gate(followup("Should I proceed?"));
  assert.equal(h.escalations.length, 0, "confident answer, no escalation");
  assert.equal(h.sent.length, 1, "auto-answered");

  // Now escalate one
  const h2 = harness({ escalateAll: true });
  await h2.gate(followup("Which file?"));
  assert.equal(h2.escalations.length, 1, "escalated");
  assert.equal(h2.sent.length, 0, "not auto-answered");

  // Human answers
  h2.answerHuman("src/config.ts");
  assert.equal(h2.sent.length, 1, "human answer sent");
  assert.equal(h2.sent[0], "src/config.ts");
  assert.match(h2.logs.join("\n"), /human answered escalated followup/);
  assert.match(h2.notes.at(-1)!.note, /Human answered/);
  assert.equal(h2.notes.at(-1)!.author, "human");
});

test("answerHuman ignores answer if no pending escalation", () => {
  const h = harness();
  h.answerHuman("some answer");
  assert.equal(h.sent.length, 0, "no message sent");
  assert.match(h.logs.join("\n"), /no pending escalation/);
});

test("answerHuman ignores answer if dispatch is no longer active", async () => {
  let active = true;
  const h = harness({ escalateAll: true, isActive: () => active });
  await h.gate(followup("Which file?"));
  assert.equal(h.escalations.length, 1, "escalated");

  // Dispatch ends
  active = false;

  // Human tries to answer
  h.answerHuman("src/config.ts");
  assert.equal(h.sent.length, 0, "answer not sent (stale)");
  assert.match(h.logs.join("\n"), /after dispatch ended.*ignoring.*stale/);
});

test("answerHuman clears pending escalation after sending", async () => {
  const h = harness({ escalateAll: true });
  await h.gate(followup("Which file?"));
  assert.notEqual(h.getPending(), null, "escalation is pending");

  h.answerHuman("src/config.ts");
  assert.equal(h.getPending(), null, "escalation cleared after answer");

  // Second answer is ignored
  h.answerHuman("another answer");
  assert.equal(h.sent.length, 1, "only first answer sent");
});

test("getPending returns the escalated question details", async () => {
  const h = harness({ escalateAll: true });
  assert.equal(h.getPending(), null, "no pending escalation initially");

  await h.gate(followup("Which file?", ["src/a.ts", "src/b.ts"]));
  const pending = h.getPending();
  assert.notEqual(pending, null);
  assert.equal(pending!.question, "Which file?");
  assert.deepEqual(pending!.options, ["src/a.ts", "src/b.ts"]);
  assert.equal(pending!.taskId, 7);
});
