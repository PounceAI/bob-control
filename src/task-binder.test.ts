import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskBinder } from "./task-binder.js";

const CREATE = "taskCreated";
const START = "taskStarted";
const DONE = "taskCompleted";

test("binds to the first create of an armed dispatch when no chat is open", () => {
  const b = new TaskBinder();
  b.arm();
  assert.equal(b.taskId, null);
  b.observe(CREATE, "ours");
  assert.equal(b.taskId, "ours");
  b.observe(START, "ours");
  assert.equal(b.taskId, "ours"); // first bind wins; later events don't rebind
});

test("an open chat does NOT steal the binding (the core bug)", () => {
  const b = new TaskBinder();
  // Chat opened while the worker was idle -> tracked as foreign.
  b.observe(CREATE, "chat");
  b.observe(START, "chat");
  // Worker dispatches; a foreign chat event arrives first -> must NOT bind.
  b.arm();
  b.observe(START, "chat");
  assert.equal(b.taskId, null);
  // Our task starts -> binds to us, not the chat.
  b.observe(CREATE, "ours");
  assert.equal(b.taskId, "ours");
  // The chat finishing must not be mistaken for our completion (caller compares ids).
  b.observe(DONE, "chat");
  assert.equal(b.taskId, "ours");
});

test("does not bind while idle (unarmed); only tracks foreign", () => {
  const b = new TaskBinder();
  b.observe(CREATE, "chat");
  assert.equal(b.taskId, null); // nothing binds with no dispatch in flight
  b.arm();
  b.observe(START, "chat"); // known-foreign -> skipped
  assert.equal(b.taskId, null);
  b.observe(CREATE, "ours");
  assert.equal(b.taskId, "ours");
});

test("a chat that ended before dispatch frees its id (we don't over-block)", () => {
  const b = new TaskBinder();
  b.observe(CREATE, "chat");
  b.observe(DONE, "chat"); // chat closed -> no longer foreign
  b.arm();
  b.observe(CREATE, "chat");
  assert.equal(b.taskId, "chat");
});

test("an always-open chat stays foreign across two sequential dispatches", () => {
  const b = new TaskBinder();
  b.observe(CREATE, "chat"); // chat open the whole time
  b.arm();
  b.observe(CREATE, "ours1");
  assert.equal(b.taskId, "ours1");
  b.observe(START, "chat"); // foreign mid-run, doesn't rebind
  assert.equal(b.taskId, "ours1");
  b.observe(DONE, "ours1");
  b.disarm();

  b.arm();
  b.observe(START, "chat"); // chat event first again -> must not bind
  assert.equal(b.taskId, null);
  b.observe(CREATE, "ours2");
  assert.equal(b.taskId, "ours2");
});

test("disarm stops a post-dispatch chat from binding to the finished dispatch", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "ours");
  b.observe(DONE, "ours");
  b.disarm();
  b.observe(CREATE, "chat"); // chat after the dispatch ended
  b.arm();
  b.observe(CREATE, "ours2"); // next dispatch binds its own task, not the chat
  assert.equal(b.taskId, "ours2");
});

test("known residual: a chat created AFTER arm but before our task binds to the chat", () => {
  // Bob gives no correlation id, so a brand-new chat in the bind window is indistinguishable
  // from ours. The idle watchdog recovers this far sooner than the flat timeout.
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "late-chat");
  assert.equal(b.taskId, "late-chat");
});

test("ignores events with no task id", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, undefined);
  assert.equal(b.taskId, null);
});

test("under a flood of foreign chats, recent ids stay foreign (set is bounded, not dropped wholesale)", () => {
  const b = new TaskBinder();
  for (let i = 0; i < 300; i++) b.observe(CREATE, `chat-${i}`); // exceeds MAX_FOREIGN (256)
  b.arm();
  b.observe(START, "chat-299"); // a recent foreign id must still be skipped, not bound
  assert.equal(b.taskId, null);
  b.observe(CREATE, "ours");
  assert.equal(b.taskId, "ours");
});
