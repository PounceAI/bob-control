// Gray-zone command approval, extracted from the worker so it can be tested
// without a live Bob/IPC connection. Under a mode's classifier policy, commands
// that miss Bob's static allowlist surface as an `ask`; instead of waiting for a
// human, we ask Claude and press approve/reject over IPC (needs the Bob button
// patch). Fail-safe by construction: only an explicit "approve" runs the command.
import { classifyCommand } from "./classify.js";
import { isCommandAsk } from "./command-policy.js";
import { getSharedCache, type VerdictCache } from "./verdict-cache.js";

/** The subset of BobClient the gate presses. `taskId` targets the webview instance whose current
 *  task matches it (the button patch) — the bound root by default, or an orchestrator SUBTASK when
 *  the ask came from one. Omit to press the root (current behavior). */
export interface GateClient {
  approve(taskId?: string): void;
  reject(taskId?: string): void;
}

/** A dispatch event, narrowed to the fields the gate reads. */
export interface GateEvent {
  ask?: string;
  text?: string;
  partial?: boolean;
  /** The message's unique timestamp — used to dedup a re-emitted ask while still
   *  handling a genuine re-run of the same command (which arrives as a new ts). */
  ts?: number;
  /** The task id that raised this ask — the bound root, or an owned subtask. Carried so the press
   *  lands on that task's own webview instance instead of relying on the sole-runner fallback. */
  taskId?: string;
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
  /**
   * True while this dispatch is still live. A slow (cli) verdict can land after the
   * dispatch ended, where a press would hit the next task's prompt — checked before
   * pressing. Defaults to always-active when omitted.
   */
  isActive?: () => boolean;
  /** Injectable for tests; defaults to the real classifier. */
  classify?: typeof classifyCommand;
  /** Injectable verdict cache; defaults to the shared singleton. */
  cache?: VerdictCache;
}

/**
 * Build the per-dispatch command gate. The returned function is the handler for
 * each dispatch event; it owns its own dedup + warn-once state, so create one
 * gate per dispatch. It returns a promise that resolves once a button has been
 * pressed (or immediately for events it ignores) — callers in the worker fire it
 * with `void`, while tests await it to observe the press.
 */
// A cli "ask" with one of these reasons is a transport failure (binary missing,
// not logged in, timeout), not the model judging — so it rejects EVERYTHING.
const CLI_TRANSPORT_FAILURE = /^(cli |classifier timeout|invalid )/;

export function createCommandGate(deps: GateDeps): (ev: GateEvent) => Promise<void> {
  const classify = deps.classify ?? classifyCommand;
  const cache = deps.cache ?? getSharedCache();
  const handled = new Set<string>();
  let warnedNoKey = false;
  let warnedCliFail = false;
  // Serialize: each command's classify→press runs to completion before the next
  // starts, so a slow (cli) verdict can't resolve mid-stream and press the wrong
  // prompt. Bob shows one command prompt at a time, so ordered presses stay aligned.
  let queue: Promise<void> = Promise.resolve();

  /** Classify (or reuse a cached verdict for) one command and press its button. */
  async function handleCommand(command: string, taskId?: string): Promise<void> {
    const short = command.replace(/\s+/g, " ").slice(0, 60);

    if (deps.blocked) {
      if (!warnedNoKey) {
        deps.log("  ⚠ classifier=api but ANTHROPIC_API_KEY unset — leaving command for a human.");
        warnedNoKey = true;
      }
      return;
    }

    // A prior identical command (same cwd) reuses its verdict; else ask Claude.
    let decision: "approve" | "deny" | "ask";
    let reason: string;
    let fromCache = false;
    const cached = cache.get(command, deps.cwd);
    if (cached) {
      ({ decision, reason } = cached);
      fromCache = true;
      deps.log(`  cached classifier ${decision} (${reason})`);
    } else {
      deps.log(`  ⟲ classifying command (${deps.backend}): ${short}`);
      ({ decision, reason } = await classify(
        command,
        { task: deps.task.title, cwd: deps.cwd },
        { backend: deps.backend, model: deps.model, apiKey: deps.apiKey, cliPath: deps.cliPath },
      ));
      // Cache only confident decisions. An "ask" is the fail-safe for a transport
      // failure (cli not logged in, timeout, HTTP error) as well as a genuine model
      // verdict — caching it would let a transient blip permanently reject the command
      // for the worker's lifetime, so re-evaluate "ask" next time instead.
      if (decision === "approve" || decision === "deny") cache.set(command, deps.cwd, { decision, reason });
    }

    // Dispatch may have ended while we waited (or while queued); drop the press so it
    // can't land on the next task's prompt. Still record the verdict.
    if (deps.isActive && !deps.isActive()) {
      const tag = fromCache ? "cached, stale, not pressed" : "stale, not pressed";
      deps.log(
        `  ~ stale ${fromCache ? "cached " : ""}classifier ${decision} arrived after dispatch ended — not pressing (${reason})`,
      );
      deps.addNote(deps.task.id, `Classifier ${decision} for \`${short}\` (${tag}): ${reason}`, "classifier");
      return;
    }

    if (decision === "approve") {
      deps.client.approve(taskId);
      deps.log(`  ✓ classifier approved (${reason})${fromCache ? " [cached]" : ""}`);
    } else {
      deps.client.reject(taskId);
      deps.log(
        `  ⛔ classifier ${decision === "deny" ? "denied" : "deferred→rejected"} (${reason})${fromCache ? " [cached]" : ""}`,
      );
      // Surface a failing cli backend once, so reject-everything isn't read as caution.
      if (!fromCache && deps.backend === "cli" && !warnedCliFail && CLI_TRANSPORT_FAILURE.test(reason)) {
        deps.log(
          `  ⚠ classifier cli backend is failing ("${reason}") — ALL gray-zone commands will be rejected. Check \`claude\` is installed and logged in.`,
        );
        warnedCliFail = true;
      }
    }
    deps.addNote(
      deps.task.id,
      `Classifier ${decision} for \`${short}\`${fromCache ? " (cached)" : ""}: ${reason}`,
      "classifier",
    );
  }

  return function onCommandAsk(ev: GateEvent): Promise<void> {
    if (!deps.enabled || ev.partial) return Promise.resolve();
    if (!isCommandAsk(ev.ask)) return Promise.resolve();
    const command = (ev.text ?? "").trim();
    if (!command) return Promise.resolve();
    // Dedup by ASK IDENTITY (ts): Bob re-emits the same pending ask as it streams —
    // those share a ts and are handled once. A genuine RE-RUN of the same command is a
    // NEW ask with a new ts, so it's handled (and pressed) again. (The command +
    // command_security_warning for one command share a ts too, so they dedup to one.)
    // Fall back to command text only when no ts is available. The key is scoped by taskId so a
    // root command and a same-text/same-ts SUBTASK command don't collide (they're distinct prompts
    // on different tasks); a true re-emit shares taskId+ts and still dedups to one.
    const scope = ev.taskId ?? "";
    const key = ev.ts !== undefined ? `${scope}:ts:${ev.ts}` : `${scope}:cmd:${command}`;
    if (handled.has(key)) return Promise.resolve();
    handled.add(key);
    // Chain onto the serial queue; a failure in one must not break the chain.
    const work = queue.then(() => handleCommand(command, ev.taskId));
    queue = work.catch(() => {});
    return work;
  };
}
