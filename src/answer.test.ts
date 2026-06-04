import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswer, answerFollowup } from "./answer.js";

// The parse is the safety-critical core: it must never throw and must default to
// escalation (answer:null) unless the model gave a confident, non-empty answer.

test("parseAnswer reads a confident answer", () => {
  assert.deepEqual(parseAnswer('{"answer":"Create both","escalate":false,"reason":"clear path"}'), {
    answer: "Create both",
    reason: "clear path",
  });
});

test("parseAnswer escalates when the model says so", () => {
  assert.deepEqual(parseAnswer('{"answer":"","escalate":true,"reason":"deletes data"}'), {
    answer: null,
    reason: "deletes data",
  });
});

test("parseAnswer escalates on an empty answer even without an escalate flag", () => {
  assert.equal(parseAnswer('{"answer":"   "}').answer, null);
});

test("parseAnswer escalates (null) on garbage", () => {
  assert.equal(parseAnswer("not json").answer, null);
  assert.equal(parseAnswer('{"answer":').answer, null); // truncated
  assert.equal(parseAnswer("").answer, null);
});

test("parseAnswer tolerates surrounding prose", () => {
  assert.equal(parseAnswer('Sure: {"answer":"Wait","escalate":false} ok').answer, "Wait");
});

test("answerFollowup returns the model's answer on success (api backend)", async () => {
  let body: any;
  const fetchImpl = (async (_u: string, init: any) => {
    body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: '{"answer":"Create both","escalate":false,"reason":"x"}' }] }),
    };
  }) as unknown as typeof fetch;
  const r = await answerFollowup(
    "Wait or create?",
    ["Wait", "Create both"],
    { task: "t", cwd: "/repo" },
    { backend: "api", apiKey: "k", fetchImpl },
  );
  assert.equal(r.answer, "Create both");
  // The question and offered options are passed to the model.
  assert.match(body.messages[0].content, /Wait or create\?/);
  assert.match(body.messages[0].content, /Create both/);
});

test("answerFollowup escalates (null) when the transport fails", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  const r = await answerFollowup("q", [], { task: "t", cwd: "/repo" }, { backend: "api", apiKey: "k", fetchImpl });
  assert.equal(r.answer, null);
  assert.match(r.reason, /HTTP 500/);
});

test("answerFollowup escalates (null) with no API key on the api backend", async () => {
  const r = await answerFollowup("q", [], { task: "t", cwd: "/repo" }, { backend: "api" });
  assert.equal(r.answer, null);
  assert.match(r.reason, /API_KEY/);
});

test("answerFollowup escalates an empty question without calling the model", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const r = await answerFollowup("   ", [], { task: "t", cwd: "/repo" }, { backend: "api", apiKey: "k", fetchImpl });
  assert.equal(r.answer, null);
  assert.equal(called, false);
});
