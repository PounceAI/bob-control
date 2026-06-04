import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRetry, executeRetry, type RetryPolicyDeps, type RetryDecision } from "./retry-policy.js";
import type { DispatchResult } from "./bob-ipc.js";

// A recording harness: captures logs, notes, and sleep calls for verification.
function harness(over: Partial<RetryPolicyDeps> = {}) {
  const logs: string[] = [];
  const notes: Array<{ id: number; note: string; author?: string }> = [];
  const sleeps: number[] = [];
  const deps: RetryPolicyDeps = {
    enabled: true,
    maxAttempts: 3,
    currentAttempts: 0,
    task: { id: 42, title: "test task" },
    addNote: (id, note, author) => notes.push({ id, note, author }),
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  };
  return { deps, logs, notes, sleeps };
}

const result = (status: "completed" | "aborted" | "timeout"): DispatchResult => ({
  taskId: "task-1",
  result: "",
  lastText: "",
  status,
});

test("feature disabled: never retries", () => {
  const h = harness({ enabled: false });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.delayMs, 0);
  assert.match(decision.reason, /disabled/);
});

test("timeout is a transient failure: retries when under cap", () => {
  const h = harness({ currentAttempts: 0, maxAttempts: 3 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, true);
  assert.ok(decision.delayMs > 0);
  assert.match(decision.reason, /transient 'timeout'/);
  assert.match(decision.reason, /retry 1\/3/);
});

test("aborted is a transient failure: retries when under cap", () => {
  const h = harness({ currentAttempts: 0, maxAttempts: 3 });
  const decision = shouldRetry(result("aborted"), h.deps);
  assert.equal(decision.shouldRetry, true);
  assert.ok(decision.delayMs > 0);
  assert.match(decision.reason, /transient 'aborted'/);
});

test("completed is NOT a transient failure: does not retry", () => {
  const h = harness({ currentAttempts: 0, maxAttempts: 3 });
  const decision = shouldRetry(result("completed"), h.deps);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.delayMs, 0);
  assert.match(decision.reason, /not a transient failure/);
});

test("at attempt cap: does not retry", () => {
  const h = harness({ currentAttempts: 2, maxAttempts: 3 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.delayMs, 0);
  assert.match(decision.reason, /attempt cap reached \(3\/3\)/);
});

test("one attempt below cap: retries", () => {
  const h = harness({ currentAttempts: 1, maxAttempts: 3 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, true);
  assert.match(decision.reason, /retry 2\/3/);
});

test("exponential backoff: first retry is 5s", () => {
  const h = harness({ currentAttempts: 0, maxAttempts: 5 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.delayMs, 5000);
});

test("exponential backoff: second retry is 10s", () => {
  const h = harness({ currentAttempts: 1, maxAttempts: 5 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.delayMs, 10000);
});

test("exponential backoff: third retry is 20s", () => {
  const h = harness({ currentAttempts: 2, maxAttempts: 5 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.delayMs, 20000);
});

test("exponential backoff: fourth retry is 40s", () => {
  const h = harness({ currentAttempts: 3, maxAttempts: 5 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.delayMs, 40000);
});

test("exponential backoff: capped at 60s", () => {
  const h = harness({ currentAttempts: 4, maxAttempts: 10 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.delayMs, 60000, "should cap at 60s");
});

test("exponential backoff: stays at 60s for higher attempts", () => {
  const h = harness({ currentAttempts: 10, maxAttempts: 20 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.delayMs, 60000, "should stay capped at 60s");
});

test("maxAttempts of 1: no retries allowed", () => {
  const h = harness({ currentAttempts: 0, maxAttempts: 1 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, false);
  assert.match(decision.reason, /attempt cap reached \(1\/1\)/);
});

test("maxAttempts of 2: allows exactly one retry", () => {
  const h = harness({ currentAttempts: 0, maxAttempts: 2 });
  const decision1 = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision1.shouldRetry, true);
  assert.match(decision1.reason, /retry 1\/2/);

  // After the first retry fails, we're at the cap
  h.deps.currentAttempts = 1;
  const decision2 = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision2.shouldRetry, false);
  assert.match(decision2.reason, /attempt cap reached \(2\/2\)/);
});

test("executeRetry: does nothing when shouldRetry is false", async () => {
  const h = harness();
  const decision: RetryDecision = { shouldRetry: false, delayMs: 0, reason: "test" };
  await executeRetry(decision, h.deps);
  assert.equal(h.logs.length, 0);
  assert.equal(h.notes.length, 0);
  assert.equal(h.sleeps.length, 0);
});

test("executeRetry: logs and notes when shouldRetry is true", async () => {
  const h = harness();
  const decision: RetryDecision = { shouldRetry: true, delayMs: 5000, reason: "test retry" };
  await executeRetry(decision, h.deps);
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[0], /retry: test retry/);
  assert.match(h.logs[1], /waiting 5000ms/);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].id, 42);
  assert.match(h.notes[0].note, /test retry/);
  assert.equal(h.notes[0].author, "retry-policy");
});

test("executeRetry: sleeps for the backoff delay", async () => {
  const h = harness();
  const decision: RetryDecision = { shouldRetry: true, delayMs: 10000, reason: "test" };
  await executeRetry(decision, h.deps);
  assert.equal(h.sleeps.length, 1);
  assert.equal(h.sleeps[0], 10000);
});

test("executeRetry: skips sleep when delayMs is 0", async () => {
  const h = harness();
  const decision: RetryDecision = { shouldRetry: true, delayMs: 0, reason: "test" };
  await executeRetry(decision, h.deps);
  assert.equal(h.sleeps.length, 0, "should not sleep when delay is 0");
  assert.equal(h.logs.length, 1, "should still log the retry");
});

test("task id is included in notes", async () => {
  const h = harness({ task: { id: 99, title: "special task" } });
  const decision: RetryDecision = { shouldRetry: true, delayMs: 5000, reason: "test" };
  await executeRetry(decision, h.deps);
  assert.equal(h.notes[0].id, 99);
});

test("reason is included in logs and notes", async () => {
  const h = harness();
  const decision: RetryDecision = { shouldRetry: true, delayMs: 5000, reason: "custom reason here" };
  await executeRetry(decision, h.deps);
  assert.match(h.logs[0], /custom reason here/);
  assert.match(h.notes[0].note, /custom reason here/);
});

test("multiple retries: backoff increases each time", () => {
  const h = harness({ maxAttempts: 5 });

  h.deps.currentAttempts = 0;
  const d1 = shouldRetry(result("timeout"), h.deps);
  assert.equal(d1.delayMs, 5000);

  h.deps.currentAttempts = 1;
  const d2 = shouldRetry(result("timeout"), h.deps);
  assert.equal(d2.delayMs, 10000);

  h.deps.currentAttempts = 2;
  const d3 = shouldRetry(result("timeout"), h.deps);
  assert.equal(d3.delayMs, 20000);
});

test("decision reason includes status, attempt count, and delay", () => {
  const h = harness({ currentAttempts: 1, maxAttempts: 4 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.match(decision.reason, /timeout/);
  assert.match(decision.reason, /retry 2\/4/);
  assert.match(decision.reason, /10000ms/);
});

test("feature enabled but maxAttempts is 0: no retries", () => {
  const h = harness({ enabled: true, maxAttempts: 0, currentAttempts: 0 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, false);
  assert.match(decision.reason, /attempt cap reached/);
});

test("currentAttempts equals maxAttempts minus 1: last retry allowed", () => {
  const h = harness({ currentAttempts: 2, maxAttempts: 3 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, false, "at cap, no more retries");
});

test("currentAttempts is less than maxAttempts minus 1: retry allowed", () => {
  const h = harness({ currentAttempts: 1, maxAttempts: 3 });
  const decision = shouldRetry(result("timeout"), h.deps);
  assert.equal(decision.shouldRetry, true);
});
