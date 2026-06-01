import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandGate, type GateDeps, type GateEvent } from "./command-gate.js";
import type { Classification } from "./classify.js";
import { VerdictCache } from "./verdict-cache.js";

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
    cache: new VerdictCache(), // Each test gets a fresh cache
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

test("a verdict that lands after the dispatch ends does not press a button", async () => {
  // Simulate the dispatch settling between the ask and the classifier verdict.
  let active = true;
  const h = harness({ isActive: () => active }, { decision: "approve", reason: "safe" });
  const pending = h.gate(cmd("npm test"));
  active = false; // dispatch timed out / completed while classifying
  await pending;
  assert.deepEqual(h.calls, { approve: 0, reject: 0 }, "must not press after dispatch ended");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].note, /stale, not pressed/);
});

test("a verdict that lands while the dispatch is still active presses normally", async () => {
  const h = harness({ isActive: () => true }, { decision: "approve", reason: "safe" });
  await h.gate(cmd("npm test"));
  assert.deepEqual(h.calls, { approve: 1, reject: 0 });
});

test("cli transport failure (e.g. not logged in) warns once that everything is being rejected", async () => {
  // classify returns ask with a cli-failure reason for each command.
  const h = harness({ backend: "cli" }, { decision: "ask", reason: "cli exit 1: not logged in" });
  await h.gate(cmd("some-tool --x"));
  await h.gate(cmd("other-tool --y"));
  assert.deepEqual(h.calls, { approve: 0, reject: 2 }, "both rejected");
  const warns = h.logs.filter((l) => /cli backend is failing/.test(l));
  assert.equal(warns.length, 1, "warned exactly once across many failures");
});

test("a genuine model 'ask' verdict does not trigger the cli-failure warning", async () => {
  const h = harness({ backend: "cli" }, { decision: "ask", reason: "unsure, looks risky" });
  await h.gate(cmd("weird-cmd"));
  assert.equal(h.logs.filter((l) => /cli backend is failing/.test(l)).length, 0);
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


test("cache hit: repeated command uses cached verdict without re-classifying", async () => {
  const cache = new VerdictCache();
  
  // First gate/dispatch: cache miss, should classify
  const h1 = harness({ cache }, { decision: "approve", reason: "safe build" });
  await h1.gate(cmd("npm run build"));
  assert.equal(h1.classifyArgs.length, 1, "first call should classify");
  assert.equal(h1.calls.approve, 1);
  
  // Second gate/dispatch with same command: cache hit, should NOT classify again
  const h2 = harness({ cache }, { decision: "deny", reason: "should not be called" });
  await h2.gate(cmd("npm run build"));
  assert.equal(h2.classifyArgs.length, 0, "second call should use cache, not classify again");
  assert.equal(h2.calls.approve, 1, "should still press approve from cache");
  
  // Verify cache hit was logged
  const cacheHitLog = h2.logs.find((l) => /cached classifier/.test(l));
  assert.ok(cacheHitLog, "should log cache hit");
  assert.match(cacheHitLog, /approve/);
});

test("cache differentiates commands by cwd", async () => {
  const cache = new VerdictCache();
  
  // First gate with cwd=/repo
  const h1 = harness({ cache, cwd: "/repo" }, { decision: "approve", reason: "safe in repo" });
  await h1.gate(cmd("rm -rf build"));
  assert.equal(h1.classifyArgs.length, 1);
  
  // Second gate with different cwd=/other — should classify again
  const h2 = harness({ cache, cwd: "/other" }, { decision: "deny", reason: "dangerous elsewhere" });
  await h2.gate(cmd("rm -rf build"));
  assert.equal(h2.classifyArgs.length, 1, "different cwd should not hit cache");
  assert.equal(h2.calls.reject, 1);
});

test("an 'ask' verdict is NOT cached, so it re-classifies next time", () => {
  // "ask" is also the fail-safe for a transient transport failure (cli timeout, not
  // logged in), so caching it would let a one-off blip permanently reject the command.
  // It must be re-evaluated on the next occurrence.
  const cache = new VerdictCache();
  return (async () => {
    const h1 = harness({ cache }, { decision: "ask", reason: "cli timeout" });
    await h1.gate(cmd("weird-command"));
    assert.equal(h1.calls.reject, 1, "ask rejects");
    assert.equal(cache.size(), 0, "ask must not be cached");

    // A second occurrence re-classifies rather than reusing a poisoned 'ask'.
    const h2 = harness({ cache }, { decision: "approve", reason: "fine now" });
    await h2.gate(cmd("weird-command"));
    assert.equal(h2.classifyArgs.length, 1, "must re-classify, not reuse the failure");
    assert.equal(h2.calls.approve, 1);
  })();
});

test("approve/deny verdicts ARE cached and reused", async () => {
  const cache = new VerdictCache();
  const h1 = harness({ cache }, { decision: "approve", reason: "safe" });
  await h1.gate(cmd("npm run build"));
  assert.equal(cache.size(), 1, "a confident verdict is cached");

  const h2 = harness({ cache }, { decision: "deny", reason: "should not be called" });
  await h2.gate(cmd("npm run build"));
  assert.equal(h2.classifyArgs.length, 0, "reuses the cached approve");
  assert.equal(h2.calls.approve, 1);
});

test("cache hit still records a note", async () => {
  const cache = new VerdictCache();
  
  // First gate: classify and cache
  const h1 = harness({ cache }, { decision: "approve", reason: "test" });
  await h1.gate(cmd("npm test"));
  assert.equal(h1.notes.length, 1);
  
  // Second gate: cache hit
  const h2 = harness({ cache }, { decision: "deny", reason: "should not be called" });
  await h2.gate(cmd("npm test"));
  assert.equal(h2.notes.length, 1, "cache hit should also record a note");
  assert.match(h2.notes[0].note, /cached/);
});

test("separate gates with shared cache reuse verdicts", async () => {
  const cache = new VerdictCache();
  
  // First gate classifies
  const h1 = harness({ cache }, { decision: "approve", reason: "safe" });
  await h1.gate(cmd("npm test"));
  assert.equal(h1.classifyArgs.length, 1);
  
  // Second gate (different dispatch) hits cache
  const h2 = harness({ cache }, { decision: "deny", reason: "should not be called" });
  await h2.gate(cmd("npm test"));
  assert.equal(h2.classifyArgs.length, 0, "second gate should hit cache");
  assert.equal(h2.calls.approve, 1, "should use cached approve");
});
