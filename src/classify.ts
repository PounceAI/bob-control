// Claude-backed command-safety gate. When a mode's commandPolicy is "classifier",
// commands that fall through Bob's static allowlist (SAFE_COMMANDS) reach a manual
// approval prompt; instead of waiting for a human, the worker asks Claude whether
// the command is safe to auto-run unattended and presses approve/reject for it.
//
// Two backends:
//   - api: one raw Anthropic API call (needs ANTHROPIC_API_KEY; cheap + fast, Haiku).
//   - cli: shells the installed `claude` CLI headless (reuses your Claude login, no
//          key; Sonnet-grade judgment, but each call boots the full Claude Code
//          harness so it's ~100x the tokens/cost and a few seconds slower).
//
// Fail-safe by construction: any error, timeout, or unparseable answer yields
// "ask" (treated as "do not auto-approve" by the caller), never "approve".
import { spawn as nodeSpawn } from "node:child_process";

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

export interface ClassifyDeps {
  backend?: "api" | "cli";
  /** Model override; defaults per backend (cli→Sonnet, api→Haiku). */
  model?: string;
  timeoutMs?: number;
  // api backend:
  apiKey?: string;
  fetchImpl?: typeof fetch;
  // cli backend:
  cliPath?: string;
  spawnImpl?: typeof nodeSpawn;
}

const SYSTEM = [
  "You are a command-safety gate for an UNATTENDED AI coding agent working in a developer's repo.",
  "Decide whether a shell command is safe to run with no human present:",
  "- approve: clearly safe and scoped — build/test/lint/format, version control status/diff/add/commit, reading files, installing declared deps, running the project's own scripts.",
  "- deny: clearly dangerous or out of scope — recursive/forced deletion outside build output, disk/partition/format ops, system shutdown/reboot, killing unrelated processes, reading or exfiltrating secrets/credentials, piping the network into a shell (curl|sh), force-pushing or resetting shared branches, editing files outside the workspace.",
  "- ask: anything you are not confident is safe. Prefer ask over approve when unsure.",
  'Respond with ONLY compact JSON, no prose: {"decision":"approve|deny|ask","reason":"<=12 words"}.',
].join("\n");

function buildPrompt(command: string, ctx: ClassifyContext): string {
  return `${SYSTEM}\n\nTask: ${ctx.task}\nWorkspace: ${ctx.cwd}\nCommand the agent wants to run:\n${command}`;
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
  const decision: Decision =
    obj?.decision === "approve" || obj?.decision === "deny" ? obj.decision : "ask";
  const reason = typeof obj?.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "(no reason)";
  return { decision, reason };
}

/** Route to the configured backend. Returns a safe "ask" on any failure. */
export async function classifyCommand(
  command: string,
  ctx: ClassifyContext,
  deps: ClassifyDeps,
): Promise<Classification> {
  return deps.backend === "cli" ? classifyViaCli(command, ctx, deps) : classifyViaApi(command, ctx, deps);
}

/** Raw Anthropic API call. Needs deps.apiKey. */
export async function classifyViaApi(
  command: string,
  ctx: ClassifyContext,
  deps: ClassifyDeps,
): Promise<Classification> {
  if (!deps.apiKey) return { decision: "ask", reason: "no ANTHROPIC_API_KEY for api backend" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = deps.model ?? "claude-haiku-4-5";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `Task: ${ctx.task}\nWorkspace: ${ctx.cwd}\nCommand the agent wants to run:\n${command}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { decision: "ask", reason: `classifier HTTP ${res.status}` };
    const json: any = await res.json();
    return parseDecision(String(json?.content?.[0]?.text ?? "").trim());
  } catch (e) {
    return { decision: "ask", reason: `classifier error: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Headless `claude -p` call — a real Claude (sub)agent that reuses the user's
 * existing login (no API key). Prompt goes over stdin (never argv, so the command
 * text can't break out); the classifier runs with mutating/exec tools disallowed.
 */
export async function classifyViaCli(
  command: string,
  ctx: ClassifyContext,
  deps: ClassifyDeps,
): Promise<Classification> {
  const spawn = deps.spawnImpl ?? nodeSpawn;
  const cli = deps.cliPath ?? "claude";
  const model = deps.model ?? "claude-sonnet-4-6";
  if (!/^[a-z0-9.\-]+$/i.test(model)) return { decision: "ask", reason: "invalid model name" };
  if (!/^[a-z0-9 .\-_\\/:]+$/i.test(cli)) return { decision: "ask", reason: "invalid cli path" };
  const argv = ["-p", "--model", model, "--output-format", "json", "--disallowed-tools", "Bash", "Write", "Edit", "NotebookEdit"];
  return new Promise<Classification>((resolve) => {
    let done = false;
    const finish = (c: Classification) => {
      if (!done) {
        done = true;
        resolve(c);
      }
    };
    let child;
    try {
      // On Windows `claude` is a .cmd/.exe shim that needs the shell to resolve. We
      // pass a single command STRING (not an args array) so Node doesn't unescaped-
      // concat an array under shell:true (DEP0190); every token here is a fixed flag
      // or the validated model, and the command being judged goes in via stdin only.
      child =
        process.platform === "win32"
          ? spawn(`"${cli}" ${argv.join(" ")}`, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
          : spawn(cli, argv, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return finish({ decision: "ask", reason: `cli spawn failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ decision: "ask", reason: "classifier timeout" });
    }, deps.timeoutMs ?? 60_000);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ decision: "ask", reason: `cli error: ${e.message}` });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({ decision: "ask", reason: `cli exit ${code}${err ? `: ${err.replace(/\s+/g, " ").slice(0, 60)}` : ""}` });
        return;
      }
      // --output-format json wraps the answer in {type:"result", result:"<text>"}.
      try {
        finish(parseDecision(String(JSON.parse(out)?.result ?? "")));
      } catch {
        finish(parseDecision(out));
      }
    });
    try {
      child.stdin?.end(buildPrompt(command, ctx));
    } catch {
      /* spawn error path already handles it */
    }
  });
}
