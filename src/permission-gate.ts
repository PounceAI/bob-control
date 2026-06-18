// Default-on, non-interactive permission gate. When Bob surfaces a shell-command approval ask, this
// resolves it deterministically (command-policy.ts) with NO model call and NO human: an allowlisted
// command is approved over IPC; a denied or unrecognised one is rejected, recorded as a structured
// needs_input (the exact command + cwd + task), and the dispatch is ended immediately so a blocked
// command can never burn the wall-clock. An unrecognised command is handed to the optional LLM
// classifier only when it's explicitly enabled; otherwise the gate default-denies and surfaces it.
//
// This is the headless analog of an Agent SDK canUseTool callback / a CLI --permission-prompt-tool:
// the agent never waits on an interactive permission decision.
import { evaluateCommand, isCommandAsk, type PolicyConfig } from "./command-policy.js";
import type { GateClient, GateEvent } from "./command-gate.js";

/** The subset of BobClient the gate drives — the command-gate's approve/reject plus the cancel it
 *  needs to end a dispatch on a blocking deny. */
export interface PermissionClient extends GateClient {
  /** End the in-flight dispatch (cancel the Bob task) so a denied command doesn't burn the wall-clock. */
  cancelActive(): void;
}

/** A dispatch event, narrowed to the fields the gate reads (shared with the command-gate). */
export type PermissionEvent = GateEvent;

/** What the gate did with an event, so the caller knows whether to fall back to the LLM classifier. */
export type PermissionVerdict = "handled" | "escalate" | "ignored";

export interface PermissionGateDeps {
  /** Gate active (default-on for execute-capable modes). */
  enabled: boolean;
  /** Extra allow/deny prefixes + repoRoot for the deterministic policy. */
  policy?: PolicyConfig;
  /** When true, an unrecognised ("escalate") command is handed back to the caller (the LLM
   *  classifier) instead of being default-denied + surfaced. */
  escalateToLlm?: boolean;
  task: { id: number; title: string };
  cwd: string;
  client: PermissionClient;
  addNote: (taskId: number, note: string, author?: string) => void;
  log: (msg: string) => void;
  /** True while the dispatch is live; a stale press/surface after it ends is dropped. */
  isActive?: () => boolean;
  /** Raise a structured needs_input for a denied/unknown command (the exact command + cwd + task). */
  surface: (info: { command: string; cwd: string; reason: string }) => void;
  /** Injectable policy evaluator for tests. */
  evaluate?: typeof evaluateCommand;
}

/**
 * Build the per-dispatch permission gate. The returned handler is called for each dispatch event and
 * returns synchronously (the policy is a pure function — no await): "handled" (pressed + possibly
 * surfaced), "escalate" (unrecognised AND the LLM classifier is enabled — the caller runs it), or
 * "ignored". Create one per dispatch; it owns its own dedup + surface-once state.
 */
export function createPermissionGate(deps: PermissionGateDeps): (ev: PermissionEvent) => PermissionVerdict {
  const evaluate = deps.evaluate ?? evaluateCommand;
  const handled = new Set<string>();
  let surfaced = false; // surface + end the dispatch at most once

  return function onCommandAsk(ev: PermissionEvent): PermissionVerdict {
    if (!deps.enabled || ev.partial) return "ignored";
    if (!isCommandAsk(ev.ask)) return "ignored";
    const command = (ev.text ?? "").trim();
    if (!command) return "ignored";
    // Dispatch may have ended (e.g. an earlier deny already cancelled it) — don't press a stale prompt.
    // Checked BEFORE the dedup bookkeeping so an event we ignore for inactivity doesn't consume the
    // dedup key (a genuine re-emit once active would then be skipped).
    if (deps.isActive && !deps.isActive()) return "ignored";
    // Dedup by ask identity (ts): Bob re-emits one pending ask as it streams (same ts); a genuine
    // re-run of the same command arrives as a new ts. Fall back to the command text when no ts. The
    // key is scoped by taskId so a root command and a same-text/same-ts SUBTASK command don't collide;
    // a true re-emit shares taskId+ts and still dedups to one.
    const scope = ev.taskId ?? "";
    const key = ev.ts !== undefined ? `${scope}:ts:${ev.ts}` : `${scope}:cmd:${command}`;
    if (handled.has(key)) return "ignored";
    handled.add(key);

    const short = command.replace(/\s+/g, " ").slice(0, 80);
    const { decision, reason } = evaluate(command, deps.policy ?? {});

    if (decision === "allow") {
      deps.client.approve(ev.taskId);
      deps.log(`  ✓ permission: auto-approved (${reason}): ${short}`);
      deps.addNote(deps.task.id, `Permission gate APPROVED \`${short}\`: ${reason}`, "permission-gate");
      return "handled";
    }

    if (decision === "escalate" && deps.escalateToLlm) {
      // Hand to the LLM classifier (the caller wires the command-gate to run on "escalate").
      deps.log(`  ↗ permission: '${short}' not on the allowlist → escalating to the classifier`);
      return "escalate";
    }

    // deny, OR escalate with no classifier → default-deny: reject, surface, end the dispatch.
    deps.client.reject(ev.taskId);
    const why = decision === "deny" ? reason : `default-deny: ${reason}`;
    deps.log(`  ⛔ permission: denied (${why}) → needs_input + ending dispatch: ${short}`);
    deps.addNote(deps.task.id, `Permission gate DENIED \`${short}\`: ${why}`, "permission-gate");
    if (!surfaced) {
      surfaced = true;
      deps.surface({ command, cwd: deps.cwd, reason: why });
      deps.client.cancelActive();
    }
    return "handled";
  };
}
