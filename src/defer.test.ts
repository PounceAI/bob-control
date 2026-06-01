import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalActivity } from "./defer.js";

// The worker defers dispatch while the user is chatting with Bob. These tests pin
// that behavior, including the self-heal that keeps a missed terminal event from
// wedging a long-lived worker into deferring forever.

const ev = (name: string, taskId = "t1", isOwn = false) => ({ name, taskId, isOwn });

test("defers while an external task is active", () => {
  const a = new ExternalActivity(() => 0);
  a.handle(ev("taskStarted"));
  assert.equal(a.shouldDefer(60_000), true);
});

test("never defers if no external activity was ever seen", () => {
  const a = new ExternalActivity(() => 0);
  assert.equal(a.shouldDefer(60_000), false);
});

test("our own dispatch is not treated as a chat", () => {
  const a = new ExternalActivity(() => 0);
  a.handle(ev("taskStarted", "t1", true));
  assert.equal(a.shouldDefer(60_000), false);
});

test("after a task completes, defers only within the idle window", () => {
  let t = 0;
  const a = new ExternalActivity(() => t);
  a.handle(ev("taskStarted"));
  a.handle(ev("taskCompleted"));
  assert.equal(a.shouldDefer(60_000), true, "just finished -> still within idle window");
  t = 60_001;
  assert.equal(a.shouldDefer(60_000), false, "idle window elapsed -> resume");
});

test("a start with no matching terminal event self-heals after the default staleMs (5 min)", () => {
  let t = 0;
  const a = new ExternalActivity(() => t); // default staleMs
  a.handle(ev("taskStarted")); // taskCompleted/taskAborted never arrives (e.g. cancelled sub-task)
  t = 4 * 60_000;
  assert.equal(a.shouldDefer(60_000), true, "still deferring before staleMs");
  t = 5 * 60_000 + 1;
  assert.equal(a.shouldDefer(60_000), false, "stale active entry evicted -> no longer wedged");
});

test("eviction is per-entry: a fresh start keeps deferring while a stale one ages out", () => {
  let t = 0;
  const a = new ExternalActivity(() => t, 1000);
  a.handle(ev("taskStarted", "stuck"));
  t = 500;
  a.handle(ev("taskStarted", "fresh"));
  t = 1001; // 'stuck' is 1001ms old (>= staleMs), 'fresh' is 501ms old
  assert.equal(a.shouldDefer(60_000), true, "fresh task still active -> defer");
});
