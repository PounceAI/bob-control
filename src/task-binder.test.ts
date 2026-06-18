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

// ── Owned subtask tree (orchestrator) ─────────────────────────────────────────────────────────

test("adopts a subtask spawned (newTask) by our task into the owned tree", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  assert.equal(b.taskId, "root");
  assert.ok(b.isOwned("root"));
  b.noteSpawnFrom("root"); // our task fired the newTask tool
  b.observe(CREATE, "sub"); // its child arrives next
  assert.ok(b.isOwned("sub")); // adopted as ours
  assert.equal(b.taskId, "root"); // root binding unchanged — a subtask never rebinds the dispatch
});

test("a chat with no newTask provenance is NOT adopted (the safety property)", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.observe(CREATE, "chat"); // appears mid-dispatch, but no spawn announced
  assert.equal(b.isOwned("chat"), false); // stays foreign — we must never auto-act on a user chat
});

test("noteSpawnFrom from a non-owned task does nothing (can't be tricked by a chat)", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("chat"); // a foreign task 'spawning' must not arm adoption
  b.observe(CREATE, "chat");
  assert.equal(b.isOwned("chat"), false);
});

test("the spawn expectation is one-shot: only the immediate next create is adopted", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("root");
  b.observe(CREATE, "sub1"); // adopted
  b.observe(CREATE, "sub2"); // not adopted — expectation already consumed
  assert.ok(b.isOwned("sub1"));
  assert.equal(b.isOwned("sub2"), false);
});

test("a subtask spawning a grandchild extends the tree (owned task can spawn)", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("root");
  b.observe(CREATE, "sub");
  b.noteSpawnFrom("sub"); // the subtask (owned) spawns its own child
  b.observe(CREATE, "grandchild");
  assert.ok(b.isOwned("grandchild"));
});

test("arm() clears the owned tree for the next dispatch", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("root");
  b.observe(CREATE, "sub");
  b.observe(DONE, "sub"); // subtask done; root unaffected
  assert.equal(b.taskId, "root");
  b.disarm();
  b.arm();
  assert.equal(b.taskId, null);
  assert.equal(b.isOwned("root"), false);
  assert.equal(b.isOwned("sub"), false);
});

test("noteSpawnFrom while unarmed is a no-op", () => {
  const b = new TaskBinder();
  b.noteSpawnFrom("anything");
  b.arm();
  b.observe(CREATE, "x"); // would be the root, not an adopted child
  assert.equal(b.taskId, "x");
  assert.ok(b.isOwned("x"));
});

test("releaseChild drops an adopted subtask but never the bound root", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("root");
  b.observe(CREATE, "sub");
  assert.ok(b.isOwned("sub"));
  b.releaseChild("sub");
  assert.equal(b.isOwned("sub"), false); // subtask popped → owned stays bounded
  b.releaseChild("root"); // must NOT drop the root
  assert.ok(b.isOwned("root"));
  assert.equal(b.taskId, "root");
});

test("a re-emitted newTask frame (same ts) does not re-arm the adoption one-shot", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("root", 7); // spawn announced (ts 7)
  b.observe(CREATE, "sub"); // child adopted, one-shot consumed
  assert.ok(b.isOwned("sub"));
  b.noteSpawnFrom("root", 7); // SAME frame re-emitted — must not re-arm
  b.observe(CREATE, "chat"); // so an unrelated create is NOT mis-adopted
  assert.equal(b.isOwned("chat"), false);
});

test("a genuine second spawn (new ts) re-arms and adopts the next child", () => {
  const b = new TaskBinder();
  b.arm();
  b.observe(CREATE, "root");
  b.noteSpawnFrom("root", 1);
  b.observe(CREATE, "subA");
  b.noteSpawnFrom("root", 2); // different ts → real second spawn
  b.observe(CREATE, "subB");
  assert.ok(b.isOwned("subA"));
  assert.ok(b.isOwned("subB"));
});
