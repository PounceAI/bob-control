import { test } from "node:test";
import assert from "node:assert/strict";
import { PollStatusLatch } from "./worker-status.js";

test("announces a status only once per uninterrupted entry", () => {
  const s = new PollStatusLatch();
  assert.equal(s.enter("idle"), true); // first time → announce
  assert.equal(s.enter("idle"), false); // still idle → stay quiet
  assert.equal(s.enter("idle"), false);
});

test("re-announces a status after a different one (stuck-'running' regression)", () => {
  // The bug: idle was latched, the worker deferred and resumed, and idle was never re-announced —
  // so the status line stuck on the post-resume state. A return to idle MUST announce again.
  const s = new PollStatusLatch();
  assert.equal(s.enter("idle"), true);
  assert.equal(s.enter("deferred"), true); // user chatting → defer
  assert.equal(s.enter("idle"), true); // chat idle, no task → idle re-announces (was the bug)
});

test("models the full defer→resume→idle loop sequence", () => {
  const s = new PollStatusLatch();
  // Worker goes idle.
  assert.equal(s.enter("idle"), true);
  // A foreign chat trips defer.
  assert.equal(s.enter("deferred"), true);
  assert.equal(s.enter("deferred"), false); // still deferring → no repeat
  // Chat idle: the loop checks is("deferred") to emit the one-shot "resumed".
  assert.equal(s.is("deferred"), true);
  // No eligible task → back to idle, which must re-announce.
  assert.equal(s.enter("idle"), true);
});

test("idle re-announces after a dispatch (active) completes", () => {
  const s = new PollStatusLatch();
  assert.equal(s.enter("idle"), true);
  assert.equal(s.enter("active"), true); // a task is dispatched
  assert.equal(s.enter("idle"), true); // task done, no more → idle announces again
});

test("disarmed is announced once and re-announced on re-disarm", () => {
  const s = new PollStatusLatch();
  assert.equal(s.enter("disarmed"), true);
  assert.equal(s.enter("disarmed"), false);
  assert.equal(s.is("disarmed"), true); // loop uses this to log "board armed — resuming"
  assert.equal(s.enter("idle"), true); // re-armed, no task
  assert.equal(s.is("disarmed"), false);
  assert.equal(s.enter("disarmed"), true); // disarmed again → re-announce
});

test("is() reflects only the last entered status", () => {
  const s = new PollStatusLatch();
  assert.equal(s.is("idle"), false); // nothing entered yet
  s.enter("deferred");
  assert.equal(s.is("deferred"), true);
  assert.equal(s.is("idle"), false);
});
