// Gray-zone command approval, extracted from the worker so it can be tested
// without a live Bob/IPC connection. Under a mode's classifier policy, commands
// that miss Bob's static allowlist surface as an `ask`; instead of waiting for a
// human, we ask Claude and press approve/reject over IPC (needs the Bob button
// patch). Fail-safe by construction: only an explicit "approve" runs the command.
import { classifyCommand } from "./classify.js";

/** The subset of BobClient the gate presses. */
export interface GateClient {
  approve(): void;
  reject(): void;
}

/** A dispatch event, narrowed to the fields the gate reads. */
export interface GateEvent {
  ask?: string;
  text?: string;
  partial?: boolean;
}

export interface GateDeps {
  /** classifierOn: the policy is "classifier" AND --command-classifier is set. */
  enabled: boolean;
  /** classifierBlocked: api backend chosen but no ANTHROPIC_API_KEY. */
  blocked: boolean;
  backend: "api" | "cli";
  model?: string;
  apiKey?: string;
  cliPath?: string;
  task: { id: number; title: string };
  cwd: string;
  client: GateClient;
  addNote: (taskId: number, note: string, author?: string) => void;
  log: (msg: string) => void;
  /** Injectable for tests; defaults to the real classifier. */
  classify?: typeof classifyCommand;
}

/**
 * Build the per-dispatch command gate. The returned function is the handler for
 * each dispatch event; it owns its own dedup + warn-once state, so create one
 * gate per dispatch. It returns a promise that resolves once a button has been
 * pressed (or immediately for events it ignores) — callers in the worker fire it
 * with `void`, while tests await it to observe the press.
 */
export function createCommandGate(deps: GateDeps): (ev: GateEvent) => Promise<void> {
  const classify = deps.classify ?? classifyCommand;
  const handled = new Set<string>();
  let warnedNoKey = false;

  return function onCommandAsk(ev: GateEvent): Promise<void> {
    if (!deps.enabled || ev.partial) return Promise.resolve();
    if (ev.ask !== "command" && ev.ask !== "command_security_warning") return Promise.resolve();
    const command = (ev.text ?? "").trim();
    // Bob re-emits the same ask as the prompt streams; classify each command once.
    if (!command || handled.has(command)) return Promise.resolve();
    handled.add(command);

    if (deps.blocked) {
      if (!warnedNoKey) {
        deps.log("  ⚠ classifier=api but ANTHROPIC_API_KEY unset — leaving command for a human.");
        warnedNoKey = true;
      }
      return Promise.resolve();
    }

    const short = command.replace(/\s+/g, " ").slice(0, 60);
    deps.log(`  ⟲ classifying command (${deps.backend}): ${short}`);
    return classify(
      command,
      { task: deps.task.title, cwd: deps.cwd },
      { backend: deps.backend, model: deps.model, apiKey: deps.apiKey, cliPath: deps.cliPath },
    ).then(({ decision, reason }) => {
      if (decision === "approve") {
        deps.client.approve();
        deps.log(`  ✓ classifier approved (${reason})`);
      } else {
        deps.client.reject();
        deps.log(`  ⛔ classifier ${decision === "deny" ? "denied" : "deferred→rejected"} (${reason})`);
      }
      deps.addNote(deps.task.id, `Classifier ${decision} for \`${short}\`: ${reason}`, "classifier");
    });
  };
}
