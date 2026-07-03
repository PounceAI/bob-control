// Shared git helpers. One success-aware runner so callers can tell a failed git command
// from a legitimately empty result (the difference between "reverted" and "silently did
// nothing"). Used by the LLM-judge diff capture and the checkpoint/rollback module.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

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
export function runGit(
  args: string[],
  cwd: string,
  maxChars?: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    let proc;
    try {
      // signal: when aborted, spawn kills the child (SIGTERM on POSIX, TerminateProcess on Windows)
      // and emits 'error', so a bounded caller can unwedge a hung git and let cleanup run.
      proc = spawn("git", args, { cwd, stdio: "pipe", env: env ? { ...process.env, ...env } : undefined, signal });
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
export async function gitOut(
  args: string[],
  cwd: string,
  maxChars?: number,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  return (await runGit(args, cwd, maxChars, env, signal)).stdout;
}

export function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
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
  return r.stdout
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Per-call counter so two temp-index snapshots in one process never share a path (pid+ms alone can
// collide when calls fire within the same millisecond).
let tmpIndexSeq = 0;

/**
 * Snapshot the worktree — tracked changes AND untracked (non-ignored) files — as a git tree sha,
 * WITHOUT touching the real index: stages into a throwaway TEMP index (`add -A` → `write-tree`), so
 * unlike `git stash create` (which drops untracked files) the snapshot is untracked-aware. The sha
 * outlives the temp index (write-tree persists it). null on non-git / failure; temp index + lock are
 * always cleaned up; never throws. `signal` lets a bounded caller abort a wedged add/write-tree.
 */
export async function snapshotWorktreeTree(cwd: string, signal?: AbortSignal): Promise<string | null> {
  // --absolute-git-dir needs git ≥2.13; fall back to the always-present --git-dir (possibly
  // relative) so an older git still produces a snapshot instead of silently giving up.
  let gitDir = (await gitOut(["rev-parse", "--absolute-git-dir"], cwd)).trim();
  if (!gitDir) {
    const rel = (await gitOut(["rev-parse", "--git-dir"], cwd)).trim();
    if (rel) gitDir = resolve(cwd, rel);
  }
  if (!gitDir) return null;
  const tmpIndex = resolve(gitDir, `bob-tmp-index-${process.pid}-${Date.now()}-${tmpIndexSeq++}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // add -A stages adds + mods + deletions into the empty temp index → a faithful on-disk snapshot
    // (honoring .gitignore); signal kills a wedged child so a hang doesn't orphan a process + index.
    if (!(await runGit(["add", "-A"], cwd, undefined, env, signal)).ok) return null;
    return (await gitOut(["write-tree"], cwd, undefined, env, signal)).trim() || null;
  } finally {
    for (const f of [tmpIndex, `${tmpIndex}.lock`]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* best-effort cleanup (locked / permission) */
      }
    }
  }
}

/**
 * snapshotWorktreeTree under a timeout: on timeout it aborts the git children (a wedged clean/smudge
 * filter or network FS — `index.lock` just fails fast), so the hang is killed, its temp index cleaned
 * up, and null returned. Only a child that ignores the kill and stays wedged can still leak.
 */
export async function snapshotWorktreeTreeBounded(cwd: string, timeoutMs = 30_000): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      // stderr trail so a slow-git env (the judge silently seeing "no changes") is diagnosable.
      console.error(`[bob-control] git worktree snapshot timed out after ${timeoutMs}ms in ${cwd}`);
      controller.abort(); // kill the git children so snapshotWorktreeTree's finally drops the temp index
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([snapshotWorktreeTree(cwd, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
