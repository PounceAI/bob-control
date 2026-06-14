import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createModeSwitchGate,
  parseModeSwitch,
  isModeSwitchAsk,
  modeSwitchDecision,
  type ModeSwitchGateDeps,
  type ModeSwitchEvent,
} from "./mode-switch-gate.js";
import type { Risk } from "./modes.js";

function harness(over: Partial<ModeSwitchGateDeps> = {}) {
  const calls = { approve: 0, reject: 0 };
  const logs: string[] = [];
  const notes: Array<{ id: number; note: string; author?: string }> = [];
  const gate = createModeSwitchGate({
    enabled: true,
    maxRisk: "standard",
    canGateCommands: true,
    task: { id: 9, title: "review the diff" },
    client: { approve: () => calls.approve++, reject: () => calls.reject++ },
    addNote: (id, note, author) => notes.push({ id, note, author }),
    log: (m) => logs.push(m),
    ...over,
  });
  return { gate, calls, logs, notes };
}

/** A switchMode tool ask, as Bob wires it: ask:"tool", text = JSON {tool, mode, reason}. */
const sw = (mode: string, extra: Partial<ModeSwitchEvent> = {}): ModeSwitchEvent => ({
  ask: "tool",
  text: JSON.stringify({ tool: "switchMode", mode, reason: `need ${mode}` }),
  ...extra,
});

// ---- parseModeSwitch ----

test("parseModeSwitch reads the target slug + reason from the switchMode payload", () => {
  assert.deepEqual(parseModeSwitch(JSON.stringify({ tool: "switchMode", mode: "advanced", reason: "run git diff" })), {
    targetMode: "advanced",
    reason: "run git diff",
  });
});

test("parseModeSwitch lowercases the target slug (canonical form; defeats case-mismatch risk lookups)", () => {
  assert.equal(parseModeSwitch(JSON.stringify({ tool: "switchMode", mode: "Advanced" }))?.targetMode, "advanced");
  assert.equal(parseModeSwitch(JSON.stringify({ tool: "switchMode", mode: "  CODE  " }))?.targetMode, "code");
});

test("parseModeSwitch returns null for a non-switchMode tool ask (e.g. apply_diff)", () => {
  assert.equal(parseModeSwitch(JSON.stringify({ tool: "apply_diff", path: "a.ts" })), null);
});

test("parseModeSwitch returns null for non-JSON, empty, or slug-less payloads", () => {
  assert.equal(parseModeSwitch("not json"), null);
  assert.equal(parseModeSwitch(""), null);
  assert.equal(parseModeSwitch(JSON.stringify({ tool: "switchMode", reason: "x" })), null, "no mode → null");
  assert.equal(parseModeSwitch(JSON.stringify({ tool: "switchMode", mode: "  " })), null, "blank mode → null");
});

// ---- isModeSwitchAsk ----

test("isModeSwitchAsk is true only for a tool ask whose payload is a switchMode", () => {
  assert.equal(isModeSwitchAsk("tool", JSON.stringify({ tool: "switchMode", mode: "code" })), true);
  assert.equal(isModeSwitchAsk("tool", JSON.stringify({ tool: "apply_diff" })), false);
  assert.equal(isModeSwitchAsk("command", "git diff"), false, "a command ask is not a mode switch");
  assert.equal(isModeSwitchAsk("followup", "which file?"), false);
});

// ---- modeSwitchDecision (pure two-factor decision) ----

test("modeSwitchDecision approves a target at or below the gate, rejects one above it", () => {
  // ask=safe, code=standard, advanced=elevated; canGateCommands=true so only risk decides here.
  assert.deepEqual(modeSwitchDecision("ask", "standard", true), {
    approve: true,
    reason: "within-budget",
    targetRisk: "safe",
  });
  assert.equal(modeSwitchDecision("code", "standard", true).approve, true, "standard ≤ standard");
  assert.deepEqual(modeSwitchDecision("advanced", "standard", true), {
    approve: false,
    reason: "exceeds-risk",
    targetRisk: "elevated",
  });
  assert.equal(modeSwitchDecision("advanced", "elevated", true).approve, true, "elevated ≤ elevated");
  assert.equal(modeSwitchDecision("code", "safe", true).approve, false, "standard > safe");
});

test("modeSwitchDecision rejects a command-capable target when the dispatch can't gate commands", () => {
  // The `ask`-mode case: within risk budget, but the worker can't authorize commands the target runs.
  assert.deepEqual(modeSwitchDecision("code", "standard", false), {
    approve: false,
    reason: "ungatable-commands",
    targetRisk: "standard",
  });
  // A read-only target (commandPolicy "none" → ask itself) is still fine — it runs no commands.
  assert.equal(modeSwitchDecision("ask", "standard", false).approve, true, "switching to a no-command mode is gatable");
});

test("modeSwitchDecision: risk is checked BEFORE the command-gating factor", () => {
  // advanced exceeds the gate AND is ungatable — the reason should be the risk ceiling.
  assert.equal(modeSwitchDecision("advanced", "standard", false).reason, "exceeds-risk");
});

test("modeSwitchDecision treats an unknown/custom slug as STANDARD (never silently safe)", () => {
  assert.equal(
    modeSwitchDecision("totally-made-up", "safe", true).approve,
    false,
    "unknown defaults to standard > safe",
  );
  assert.equal(modeSwitchDecision("totally-made-up", "standard", true).approve, true);
});

// ---- the gate (press behaviour) ----

test("a within-budget, gatable switch is approved (press primary) + noted", () => {
  const h = harness({ maxRisk: "standard", canGateCommands: true });
  h.gate(sw("code"));
  assert.equal(h.calls.approve, 1);
  assert.equal(h.calls.reject, 0);
  assert.match(h.notes[0].note, /Approved mode switch to \{code\}/);
  assert.equal(h.notes[0].author, "mode-switch-gate");
});

test("an escalating switch (review→advanced past the gate) is rejected (press secondary) + noted with the risk reason", () => {
  // This is the reported wedge: a read-only review wants `advanced` to run git diff.
  const h = harness({ maxRisk: "standard", canGateCommands: true });
  h.gate(sw("advanced"));
  assert.equal(h.calls.reject, 1, "rejected — never approved");
  assert.equal(h.calls.approve, 0);
  assert.match(
    h.notes[0].note,
    /Rejected mode switch to \{advanced\}.*exceeds --max-risk.*continues in its current mode/s,
  );
});

test("a within-budget switch from a no-command dispatch (ask→code) is rejected with the ungatable reason", () => {
  // Approving would strand Bob on ungated command prompts in `code`; reject + tell the operator to
  // re-queue in a command-capable mode.
  const h = harness({ maxRisk: "standard", canGateCommands: false });
  h.gate(sw("code"));
  assert.equal(h.calls.reject, 1);
  assert.equal(h.calls.approve, 0);
  assert.match(h.notes[0].note, /can't authorize commands.*re-queue this task in a command-capable mode/s);
});

test("the case-mismatched slug 'Advanced' is still rejected as elevated (not downgraded to standard)", () => {
  const h = harness({ maxRisk: "standard", canGateCommands: true });
  h.gate(sw("Advanced"));
  assert.equal(h.calls.reject, 1, "lowercased → advanced (elevated) → rejected at standard");
  assert.equal(h.calls.approve, 0);
});

test("the same elevated switch IS approved when the operator raised --max-risk to elevated", () => {
  const h = harness({ maxRisk: "elevated", canGateCommands: true });
  h.gate(sw("advanced"));
  assert.equal(h.calls.approve, 1);
  assert.equal(h.calls.reject, 0);
});

test("a partial (streaming) ask is ignored until it finalizes", () => {
  const h = harness();
  h.gate(sw("code", { partial: true }));
  assert.equal(h.calls.approve, 0);
  assert.equal(h.calls.reject, 0);
  h.gate(sw("code", { partial: false }));
  assert.equal(h.calls.approve, 1);
});

test("a non-switchMode tool ask is ignored (not our concern)", () => {
  const h = harness();
  h.gate({ ask: "tool", text: JSON.stringify({ tool: "apply_diff", path: "a.ts" }) });
  assert.equal(h.calls.approve, 0);
  assert.equal(h.calls.reject, 0);
});

test("a command/followup ask is ignored by the mode-switch gate", () => {
  const h = harness();
  h.gate({ ask: "command", text: "git push" });
  h.gate({ ask: "followup", text: "which file?" });
  assert.equal(h.calls.approve + h.calls.reject, 0);
});

test("the same pending ask (same ts) is handled once; a genuine re-ask (new ts) is handled again", () => {
  const h = harness({ maxRisk: "standard" });
  h.gate(sw("advanced", { ts: 100 }));
  h.gate(sw("advanced", { ts: 100 })); // re-emit as it streams — same ts
  assert.equal(h.calls.reject, 1, "deduped on ts");
  h.gate(sw("advanced", { ts: 200 })); // Bob asks again — new ts
  assert.equal(h.calls.reject, 2, "a fresh ask is pressed again");
});

test("falls back to the target slug for dedup when no ts is present", () => {
  const h = harness({ maxRisk: "standard" });
  h.gate(sw("code"));
  h.gate(sw("code"));
  assert.equal(h.calls.approve, 1, "deduped on slug");
  h.gate(sw("advanced"));
  assert.equal(h.calls.reject, 1, "a different target is still handled");
});

test("a press is dropped when the dispatch is no longer active (stale)", () => {
  let active = false;
  const h = harness({ isActive: () => active });
  h.gate(sw("code"));
  assert.equal(h.calls.approve, 0, "inactive dispatch — no press");
  // ...and the key was NOT consumed, so once active the genuine ask is handled.
  active = true;
  h.gate(sw("code"));
  assert.equal(h.calls.approve, 1);
});

test("disabled gate is a no-op", () => {
  const h = harness({ enabled: false });
  h.gate(sw("code"));
  h.gate(sw("advanced"));
  assert.equal(h.calls.approve + h.calls.reject, 0);
});

test("every Risk gate value yields a press (no unhandled gate state)", () => {
  for (const r of ["safe", "standard", "elevated"] as Risk[]) {
    const h = harness({ maxRisk: r, canGateCommands: true });
    h.gate(sw("code"));
    assert.equal(h.calls.approve + h.calls.reject, 1, `${r}: exactly one press`);
  }
});
