// Deterministic, non-interactive mode-switch gate, sibling of permission-gate.ts. Mid-task Bob can
// call `switch_mode` to reach a more capable mode (e.g. a read-only review switching to `advanced` to
// run `git diff`); it surfaces as ask:"tool" with payload {tool:"switchMode", mode, reason}. With no
// human watching, this gate presses approve/reject over IPC (needs the button patch). It rejects a
// switch that escalates past the worker's risk gate (--max-risk), or one into a command-capable mode
// the dispatch can't authorize (a no-command `ask` dispatch, whose permission gate is inactive) —
// approving that only strands Bob on ungated prompts. Only a within-budget, gatable target is approved.
import { profileFor, RISK_RANK, type Risk } from "./modes.js";

/** The `ask` name Bob raises for a tool-use approval; switchMode is one of several tool asks, so the
 *  gate also matches on the parsed payload's `tool` field (see parseModeSwitch). */
export const TOOL_ASK = "tool";

export interface ParsedModeSwitch {
  /** The mode slug Bob wants to switch INTO, lowercased to Bob's canonical form. */
  targetMode: string;
  /** Bob's stated reason for the switch (may be empty). */
  reason: string;
}

/**
 * Parse a switchMode tool ask ({tool:"switchMode", mode, reason}); null for any other tool ask or
 * non-JSON text. The slug is lowercased to match MODE_PROFILES' lowercase keys, so a differently-cased
 * slug ("Advanced") can't miss the lookup and silently fall back to the STANDARD risk default.
 */
export function parseModeSwitch(text: string): ParsedModeSwitch | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.tool !== "switchMode") return null;
  const targetMode = typeof rec.mode === "string" ? rec.mode.trim().toLowerCase() : "";
  if (!targetMode) return null;
  return { targetMode, reason: typeof rec.reason === "string" ? rec.reason : "" };
}

/** True for a switchMode tool ask. Shared by the gate and the worker's isAnswerableAsk. Both gate
 *  outcomes (approve/reject) resolve the ask with a press, so answerability turns on this predicate,
 *  not on the approve/reject decision (unlike the followup gate, which mirrors its disposition). */
export function isModeSwitchAsk(ask: string | undefined, text: string | undefined): boolean {
  return ask === TOOL_ASK && parseModeSwitch(text ?? "") !== null;
}

/** Why a switch was approved/rejected — drives the note and lets tests assert the cause. */
export type ModeSwitchReason = "within-budget" | "exceeds-risk" | "ungatable-commands";

export interface ModeSwitchDecision {
  approve: boolean;
  reason: ModeSwitchReason;
  /** The target's risk, resolved once so the note and the decision can't disagree. */
  targetRisk: Risk;
}

/**
 * Pure decision: reject when the target's risk exceeds the gate, or when it runs commands the dispatch
 * can't authorize (canGateCommands=false); else approve. An unknown slug resolves to STANDARD via
 * profileFor, so a typo can't sneak past as `safe`.
 */
export function modeSwitchDecision(targetMode: string, maxRisk: Risk, canGateCommands: boolean): ModeSwitchDecision {
  const target = profileFor(targetMode);
  if (RISK_RANK[target.risk] > RISK_RANK[maxRisk]) {
    return { approve: false, reason: "exceeds-risk", targetRisk: target.risk };
  }
  if (!canGateCommands && target.commandPolicy !== "none") {
    return { approve: false, reason: "ungatable-commands", targetRisk: target.risk };
  }
  return { approve: true, reason: "within-budget", targetRisk: target.risk };
}

/** The subset of BobClient the gate presses. */
export interface ModeSwitchGateClient {
  approve(): void;
  reject(): void;
}

/** A dispatch event, narrowed to the fields the gate reads. */
export interface ModeSwitchEvent {
  ask?: string;
  text?: string;
  partial?: boolean;
  /** Message timestamp — dedup a re-emitted ask on it (a genuine re-ask has a new ts). */
  ts?: number;
}

export interface ModeSwitchGateDeps {
  /** Gate active. Mode switches can occur in any mode, so this is on for every dispatch. */
  enabled: boolean;
  /** The dispatch's risk gate (worker --max-risk) — the ceiling a switch may not exceed. */
  maxRisk: Risk;
  /** True when the worker can authorize commands the target would run (permission gate active, or a
   *  sandbox auto-runs all). False for a no-command dispatch (`ask`); see the header. */
  canGateCommands: boolean;
  task: { id: number; title: string };
  client: ModeSwitchGateClient;
  addNote: (taskId: number, note: string, author?: string) => void;
  log: (msg: string) => void;
  /** True while the dispatch is live; a stale press after it ends is dropped. */
  isActive?: () => boolean;
}

/**
 * Build the per-dispatch mode-switch gate. The returned handler runs on each dispatch event and
 * presses approve/reject synchronously (pure decision — no await, no model). One per dispatch; it owns
 * its own dedup state.
 */
export function createModeSwitchGate(deps: ModeSwitchGateDeps): (ev: ModeSwitchEvent) => void {
  const handled = new Set<string>();

  return function onModeSwitchAsk(ev: ModeSwitchEvent): void {
    if (!deps.enabled || ev.partial) return;
    if (ev.ask !== TOOL_ASK) return;
    const parsed = parseModeSwitch((ev.text ?? "").trim());
    if (!parsed) return; // some other tool ask — not ours
    // Don't press a stale prompt. Checked before the dedup bookkeeping so an event ignored for
    // inactivity doesn't consume the key (a genuine re-emit once active is then kept).
    if (deps.isActive && !deps.isActive()) return;
    // Dedup by ask identity (ts): Bob re-emits one pending ask as it streams (same ts); a genuine
    // re-ask arrives as a new ts. Fall back to the target slug when no ts.
    const key = ev.ts !== undefined ? `ts:${ev.ts}` : `mode:${parsed.targetMode}`;
    if (handled.has(key)) return;
    handled.add(key);

    const decision = modeSwitchDecision(parsed.targetMode, deps.maxRisk, deps.canGateCommands);
    const where = `{${parsed.targetMode}} (risk:${decision.targetRisk})`;
    if (decision.approve) {
      deps.client.approve();
      deps.log(`  ✓ mode-switch approved → ${where} (within --max-risk ${deps.maxRisk})`);
      deps.addNote(
        deps.task.id,
        `Approved mode switch to ${where} (within --max-risk ${deps.maxRisk}).`,
        "mode-switch-gate",
      );
      return;
    }
    deps.client.reject();
    const why =
      decision.reason === "exceeds-risk"
        ? `risk:${decision.targetRisk} exceeds --max-risk ${deps.maxRisk}; Bob continues in its current mode.`
        : `the worker can't authorize commands in ${where} for a task dispatched in a no-command mode; ` +
          `re-queue this task in a command-capable mode if it needs to run commands.`;
    deps.log(`  ⛔ mode-switch rejected → ${where} (${decision.reason})`);
    deps.addNote(deps.task.id, `Rejected mode switch to ${where}: ${why}`, "mode-switch-gate");
  };
}
