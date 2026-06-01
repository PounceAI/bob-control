// Shared transport for calling a Claude model, used by the command classifier
// (classify.ts) and the followup answerer (answer.ts). Two backends:
//   - api: one raw Anthropic API call (needs ANTHROPIC_API_KEY; cheap + fast, Haiku).
//   - cli: shells `claude -p` (reuses the Claude login, no key; Sonnet-grade, but
//          boots the full Claude Code harness so it's ~100x the tokens and slower).
// Both return a plain result; callers parse the text and decide their own fail-safe.
import { spawn as nodeSpawn } from "node:child_process";

export type LlmBackend = "api" | "cli";

export interface LlmDeps {
  backend?: LlmBackend;
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

export type LlmResult = { ok: true; text: string } | { ok: false; reason: string };

export const DEFAULT_MODELS: Record<LlmBackend, string> = {
  api: "claude-haiku-4-5",
  cli: "claude-sonnet-4-6",
};

/** Route to the configured backend. Never throws. */
export function callModel(system: string, user: string, deps: LlmDeps, maxTokens = 100): Promise<LlmResult> {
  return deps.backend === "cli" ? callCli(`${system}\n\n${user}`, deps) : callApi(system, user, deps, maxTokens);
}

/** Raw Anthropic API call returning the model's text. Needs deps.apiKey. */
export async function callApi(system: string, user: string, deps: LlmDeps, maxTokens = 100): Promise<LlmResult> {
  if (!deps.apiKey) return { ok: false, reason: "no ANTHROPIC_API_KEY for api backend" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = deps.model ?? DEFAULT_MODELS.api;
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
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json: any = await res.json();
    return { ok: true, text: String(json?.content?.[0]?.text ?? "").trim() };
  } catch (e) {
    return { ok: false, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Headless `claude -p` returning the model's text. The whole prompt goes over stdin
 * (never argv, so untrusted content can't break out); mutating/exec tools are
 * disallowed so the (sub)agent only reasons and answers.
 */
export async function callCli(prompt: string, deps: LlmDeps): Promise<LlmResult> {
  const spawn = deps.spawnImpl ?? nodeSpawn;
  const cli = deps.cliPath ?? "claude";
  const model = deps.model ?? DEFAULT_MODELS.cli;
  if (!/^[a-z0-9.\-]+$/i.test(model)) return { ok: false, reason: "invalid model name" };
  if (!/^[a-z0-9 .\-_\\/:]+$/i.test(cli)) return { ok: false, reason: "invalid cli path" };
  const argv = ["-p", "--model", model, "--output-format", "json", "--disallowed-tools", "Bash", "Write", "Edit", "NotebookEdit"];
  return new Promise<LlmResult>((resolve) => {
    let done = false;
    const finish = (r: LlmResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let child;
    try {
      // On Windows `claude` is a .cmd/.exe shim that needs the shell to resolve. Pass
      // a single command STRING (not an args array) so Node doesn't unescaped-concat
      // an array under shell:true (DEP0190); every token is a fixed flag or the
      // validated model, and the prompt arrives via stdin only.
      child =
        process.platform === "win32"
          ? spawn(`"${cli}" ${argv.join(" ")}`, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
          : spawn(cli, argv, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return finish({ ok: false, reason: `cli spawn failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, reason: "cli timeout" });
    }, deps.timeoutMs ?? 60_000);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `cli error: ${e.message}` });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({ ok: false, reason: `cli exit ${code}${err ? `: ${err.replace(/\s+/g, " ").slice(0, 60)}` : ""}` });
        return;
      }
      // --output-format json wraps the answer in {type:"result", result:"<text>"}.
      try {
        finish({ ok: true, text: String(JSON.parse(out)?.result ?? "") });
      } catch {
        finish({ ok: true, text: out });
      }
    });
    try {
      child.stdin?.end(prompt);
    } catch {
      /* spawn error path already handles it */
    }
  });
}
