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
export function runGit(args: string[], cwd: string, maxChars?: number, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    let proc;
    try {
      proc = spawn("git", args, { cwd, stdio: "pipe", env: env ? { ...process.env, ...env } : undefined });
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
export async function gitOut(args: string[], cwd: string, maxChars?: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return (await runGit(args, cwd, maxChars, env)).stdout;
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
 * Snapshot the current worktree — tracked changes AND untracked (non-ignored) files — into a git
 * tree object, returning its sha WITHOUT touching the real index. Stages into a throwaway TEMP index
 * (`add -A` → `write-tree`), so callers get an untracked-aware snapshot that `git stash create`
 * can't produce (it silently drops untracked files). `write-tree` persists the tree in the object
 * DB, so the returned sha stays valid after the temp index is removed. Returns null when cwd isn't a
 * git work tree or the snapshot can't be built. The temp index (and any leftover lock) is always
 * cleaned up; never throws.
 */
export async function snapshotWorktreeTree(cwd: string): Promise<string | null> {
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
    // add -A stages adds + modifications + deletions relative to the empty temp index → a faithful
    // snapshot of what's on disk now (still honoring .gitignore).
    if (!(await runGit(["add", "-A"], cwd, undefined, env)).ok) return null;
    return (await gitOut(["write-tree"], cwd, undefined, env)).trim() || null;
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
 * snapshotWorktreeTree under a timeout: a stuck git (index.lock, a hook's credential prompt) resolves
 * null instead of blocking the caller. On timeout the abandoned inner promise still cleans up its temp
 * index, but the `git add -A` child is NOT killed (runGit keeps no handle) — fine, since it only fires
 * when git is already wedged.
 */
export async function snapshotWorktreeTreeBounded(cwd: string, timeoutMs = 30_000): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    t.unref?.();
  });
  return Promise.race([snapshotWorktreeTree(cwd), timeout]);
}
