// Shared git helpers. One success-aware runner so callers can tell a failed git command
// from a legitimately empty result (the difference between "reverted" and "silently did
// nothing"). Used by the LLM-judge diff capture and the checkpoint/rollback module.
import { spawn } from "node:child_process";

export interface GitResult {
  /** git exited 0, OR we killed it at maxChars. When `truncated`, `ok` means "stopped on
   *  purpose", not "git succeeded" — so don't pass maxChars when you rely on `ok`. */
  ok: boolean;
  /** Hit maxChars and killed the process; `stdout` is partial, the exit code unknown. */
  truncated: boolean;
  stdout: string;
}

/**
 * Run a git command. Resolves { ok, truncated, stdout } — never rejects, so callers stay total,
 * but `ok` reflects the real exit code (unlike a swallow-everything runner). When maxChars is
 * set the process is killed and output truncated once the limit is exceeded; in that case
 * `truncated` is true and `ok` only means "stopped deliberately", not "git succeeded".
 */
export function runGit(args: string[], cwd: string, maxChars?: number): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    let proc;
    try {
      proc = spawn("git", args, { cwd, stdio: "pipe" });
    } catch {
      return resolve({ ok: false, truncated: false, stdout: "" });
    }
    let out = "";
    let truncated = false;
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      out += chunk.toString();
      if (maxChars && out.length > maxChars) {
        out = out.slice(0, maxChars) + "\n... (output truncated)";
        truncated = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    });
    proc.on("close", (code) => resolve({ ok: truncated || code === 0, truncated, stdout: out }));
    proc.on("error", () => resolve({ ok: false, truncated, stdout: out }));
  });
}

/** Convenience: stdout only (for callers that don't care whether git succeeded). */
export async function gitOut(args: string[], cwd: string, maxChars?: number): Promise<string> {
  return (await runGit(args, cwd, maxChars)).stdout;
}

export function splitLines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function isInsideWorkTree(cwd: string): Promise<boolean> {
  return (await gitOut(["rev-parse", "--is-inside-work-tree"], cwd)).trim() === "true";
}

/** Absolute repo top-level, or null if cwd isn't a git work tree. Repo identity for a checkpoint. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "--show-toplevel"], cwd);
  const top = r.stdout.trim();
  return r.ok && top ? top : null;
}

/** HEAD sha, or null on an unborn branch (no commits). */
export async function headSha(cwd: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "HEAD"], cwd);
  const sha = r.stdout.trim();
  return r.ok && sha ? sha : null;
}

/** True if a ref/sha resolves to an existing object in this repo. */
export async function refExists(ref: string, cwd: string): Promise<boolean> {
  return (await runGit(["cat-file", "-e", `${ref}^{commit}`], cwd)).ok;
}

/**
 * Untracked files (NUL-separated, no C-quoting, so non-ASCII names survive), excluding
 * gitignored by default. Paths are relative to `cwd`.
 */
export async function listUntracked(cwd: string): Promise<string[]> {
  const r = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  return r.stdout.split("\0").map((s) => s.trim()).filter(Boolean);
}
