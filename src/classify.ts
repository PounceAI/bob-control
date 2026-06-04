// Claude-backed command-safety gate. When a mode's commandPolicy is "classifier",
// commands that fall through Bob's static allowlist reach a manual approval prompt;
// instead of waiting for a human, the worker asks Claude whether the command is safe
// to auto-run unattended and presses approve/reject for it.
//
// The model transport (api vs cli backend) lives in llm.ts; this module owns the
// command-safety prompt and the fail-safe parse: any error, timeout, or unparseable
// answer yields "ask" (treated as "do not auto-approve" by the caller), never "approve".
import { callModel, type LlmDeps } from "./llm.js";

export type Decision = "approve" | "deny" | "ask";
export interface Classification {
  decision: Decision;
  reason: string;
}

export interface ClassifyContext {
  /** The task title/prompt, so the classifier can judge relevance. */
  task: string;
  /** Workspace path, to judge whether the command stays in-scope. */
  cwd: string;
}

/** Backend + model + transport overrides (see llm.ts). */
export type ClassifyDeps = LlmDeps;

const SYSTEM = [
  "You are a command-safety gate for an UNATTENDED AI coding agent working in a developer's repo.",
  "Decide whether a shell command is safe to run with no human present:",
  "- approve: clearly safe and scoped — build/test/lint/format, version control status/diff/add/commit, reading files, installing declared deps, running the project's own scripts.",
  "- deny: clearly dangerous or out of scope — recursive/forced deletion outside build output, disk/partition/format ops, system shutdown/reboot, killing unrelated processes, reading or exfiltrating secrets/credentials, piping the network into a shell (curl|sh), force-pushing or resetting shared branches, editing files outside the workspace.",
  "- ask: anything you are not confident is safe. Prefer ask over approve when unsure.",
  'Respond with ONLY compact JSON, no prose: {"decision":"approve|deny|ask","reason":"<=12 words"}.',
].join("\n");

function userContent(command: string, ctx: ClassifyContext): string {
  return `Task: ${ctx.task}\nWorkspace: ${ctx.cwd}\nCommand the agent wants to run:\n${command}`;
}

/**
 * Parse the model's reply into a Classification. Pure and total: never throws,
 * defaults to a safe "ask" when the output isn't a clear decision.
 */
export function parseDecision(text: string): Classification {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { decision: "ask", reason: "no JSON in classifier output" };
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return { decision: "ask", reason: "unparseable classifier output" };
  }
  const decision: Decision = obj?.decision === "approve" || obj?.decision === "deny" ? obj.decision : "ask";
  const reason = typeof obj?.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "(no reason)";
  return { decision, reason };
}

/** Judge a command via the configured backend. Returns a safe "ask" on any failure. */
export async function classifyCommand(
  command: string,
  ctx: ClassifyContext,
  deps: ClassifyDeps,
): Promise<Classification> {
  const res = await callModel(SYSTEM, userContent(command, ctx), deps, 100);
  return res.ok ? parseDecision(res.text) : { decision: "ask", reason: res.reason };
}
