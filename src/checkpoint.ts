// Per-task git checkpoint + rollback. Designed so a destructive revert is safe by
// construction: the checkpoint is BOUND to a repo (refuses a revert in any other tree),
// PINNED behind a real ref (gc can't drop the snapshot), VERIFIED before anything is touched
// (missing snapshot / moved HEAD → refuse, not silent half-revert), RECOVERABLE (the
// about-to-be-discarded state is pinned too, and a pin that can't be built refuses the revert),
// restored WITHOUT moving HEAD (read-tree, so a task's commit is never orphaned), and BOUNDED
// (one deadline per operation: a wedged git here would orphan the task in_progress behind a live
// heartbeat).
import { unlinkSync, rmdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { runGit, repoRoot, headSha, refExists, listUntracked, snapshotWorktreeTree, gitFailure } from "./git.js";
import * as repo from "./db.js";
import type { TaskCheckpoint } from "./types.js";

const CHECKPOINT_REF = (taskId: number) => `refs/bob/checkpoint/${taskId}`;
const RECOVERY_REF = (sha: string) => `refs/bob/recovery/${sha}`;
/** Discoverable branch a task's preserved partial work is saved to on a terminal failure. */
export const TASK_BRANCH = (taskId: number) => `bob/task-${taskId}`;

/** One deadline per public operation. Post-restore bookkeeping (task branch, pin release) gets its
 *  own, so an exhausted one can't skip it. */
const DEADLINE_MS = 120_000;
const deadline = (signal?: AbortSignal) => signal ?? AbortSignal.timeout(DEADLINE_MS);
const git = (args: string[], cwd: string, signal: AbortSignal, env?: NodeJS.ProcessEnv) =>
  runGit(args, cwd, undefined, env, signal);
const TIMED_OUT = "git timed out — refusing to revert";

export interface CheckpointOpts {
  /** Deadline for every git call in the operation (default: a fresh DEADLINE_MS timeout). */
  signal?: AbortSignal;
}

/**
 * Capture a rollback checkpoint for `cwd` (a git work tree). Snapshots the tracked tree as a
 * commit and PINS it behind refs/bob/checkpoint/<taskId> so git gc can't reclaim it. Reuses
 * `snapshotRef` (e.g. the worker's evidence stash) when given to avoid a second stash. Returns
 * null when cwd isn't a git work tree or git failed/timed out (restore trusts every field, so no
 * checkpoint beats a wrong one).
 */
export async function captureCheckpoint(
  cwd: string,
  taskId: number,
  snapshotRef?: string,
  opts: CheckpointOpts = {},
): Promise<TaskCheckpoint | null> {
  const signal = deadline(opts.signal);
  const root = await repoRoot(cwd, signal);
  if (!root) return null;
  const head = await headSha(cwd, signal);
  // A commit of the current tracked tree: reuse the caller's stash-create sha if it's a real
  // object, else make one; fall back to HEAD when the tree is clean (nothing to stash). A failed
  // stash create is not "clean": a HEAD baseline would let a revert discard pre-task edits.
  let snapshot = snapshotRef && snapshotRef !== "HEAD" ? snapshotRef : "";
  if (!snapshot && head) {
    const stash = await git(["stash", "create"], cwd, signal);
    if (!stash.ok) return null;
    snapshot = stash.stdout.trim();
  }
  if (!snapshot) snapshot = head ?? "";
  let ref = "";
  if (snapshot) {
    const pin = CHECKPOINT_REF(taskId);
    if ((await git(["update-ref", pin, snapshot], cwd, signal)).ok) {
      ref = pin;
    } else if (snapshot === head) {
      ref = snapshot; // no pin, but HEAD's branch ref keeps it gc-safe
    } else {
      return null; // can't pin a dangling stash sha → gc-prunable; don't promise gc-safety
    }
  }
  // Restore deletes whatever is untracked and NOT in this list, so a failed listing can't be "none".
  const untracked = await listUntracked(cwd, signal);
  if (!untracked) return null;
  return { root, head, ref, untracked };
}

export interface RestoreOutcome {
  reverted: boolean;
  /** Human-readable result (success detail, or why it refused). */
  note: string;
  /** Task-created files removed. */
  removed: string[];
  /** Ref pinning the pre-revert state, so the discarded work is recoverable. */
  recoveryRef?: string;
}

/**
 * Restore `cwd` to a checkpoint. Refuses (reverted:false, no mutation) when: cwd isn't a git
 * tree, it's a DIFFERENT repo than the checkpoint, HEAD moved since capture (unless force), the
 * snapshot object is gone, git timed out, or the current state can't be pinned for recovery.
 * Otherwise pins the current state, restores tracked files via `read-tree` (HEAD untouched), and
 * removes only files the task created.
 */
export async function restoreCheckpoint(
  cwd: string,
  cp: TaskCheckpoint,
  opts: { force?: boolean } & CheckpointOpts = {},
): Promise<RestoreOutcome> {
  const signal = deadline(opts.signal);
  const refuse = (note: string): RestoreOutcome => ({ reverted: false, removed: [], note });
  const root = await repoRoot(cwd, signal);
  if (!root) return refuse(signal.aborted ? TIMED_OUT : "not a git work tree — refusing to revert");
  if (cp.root && root !== cp.root)
    return refuse(`checkpoint belongs to ${cp.root}, not ${root} — refusing (wrong repo)`);
  const head = await headSha(cwd, signal);
  if (signal.aborted) return refuse(TIMED_OUT);
  if (!opts.force && (head ?? null) !== (cp.head ?? null)) {
    return refuse(
      `HEAD moved since checkpoint (was ${cp.head?.slice(0, 8) ?? "none"}, now ${head?.slice(0, 8) ?? "none"}) — refusing; pass force to override`,
    );
  }
  if (cp.ref && !(await refExists(cp.ref, cwd, signal))) {
    return refuse(
      signal.aborted ? TIMED_OUT : "checkpoint snapshot is missing (gc'd or wrong repo) — refusing to revert",
    );
  }

  // Pin the current state (tracked changes AND untracked files) BEFORE we destroy it, so the
  // discarded work is recoverable — including a task whose only change is a brand-new file. A pin
  // that can't be built refuses the revert: never destroy unrecoverably.
  const pin = await pinRecoverySnapshot(cwd, head, signal);
  if (!pin.ok) return refuse(`could not pin the current state for recovery (${pin.reason}) — refusing to revert`);
  const recoveryRef = pin.ref;
  const recoveryNote = recoveryRef ? `; recovery ${recoveryRef}` : "";

  // Restore tracked files to the snapshot tree WITHOUT moving HEAD (read-tree, not reset --hard,
  // so a commit the task made is never orphaned). Then unstage so the diff reads as pre-task.
  if (cp.ref) {
    const rt = await git(["read-tree", "-u", "--reset", `${cp.ref}^{tree}`], cwd, signal);
    if (!rt.ok) {
      return {
        reverted: false,
        removed: [],
        note: `${gitFailure("read-tree", rt, signal)} — tree not restored`,
        recoveryRef,
      };
    }
    await git(["reset", "-q"], cwd, signal);
  }

  // Remove files the task created (only now that the tracked restore succeeded), and prune
  // directories left empty. Without a listing, remove nothing: "not in the list" would be everything.
  const prior = new Set(cp.untracked);
  const now = await listUntracked(cwd, signal);
  if (!now) {
    return {
      reverted: true,
      removed: [],
      note: `restored tracked files; task-created files NOT removed (git ls-files failed)${recoveryNote}`,
      recoveryRef,
    };
  }
  const removed: string[] = [];
  const cwdAbs = resolve(cwd);
  for (const f of now.filter((f) => !prior.has(f))) {
    const abs = resolve(cwd, f);
    // Defense-in-depth: listUntracked returns repo-relative paths so `abs` is already under the work
    // tree — still refuse to unlink anything that resolves outside it.
    if (abs !== cwdAbs && !abs.startsWith(cwdAbs + sep)) continue;
    try {
      unlinkSync(abs);
      removed.push(f);
      pruneEmptyDirs(cwd, f);
    } catch {
      /* already gone / not removable */
    }
  }
  const removedNote = removed.length ? `; removed ${removed.length} created file(s)` : "";
  return {
    reverted: true,
    removed,
    note: `restored to checkpoint${removedNote}${recoveryNote}`,
    recoveryRef,
  };
}

/**
 * Drop a task's checkpoint record AND delete its pin ref (best-effort), so a consumed or obsolete
 * checkpoint can't leak a gc-immune snapshot. Shared consume step for revert, preserve-to-branch, and
 * a successful completion (otherwise a default-on checkpoint would pin one commit per task forever).
 * No-op when the task has no checkpoint. Never throws. Own deadline: the record is cleared before
 * the ref delete, so a skipped update-ref would leak the pin ref for good.
 */
export async function releaseCheckpoint(taskId: number, fallbackCwd?: string): Promise<void> {
  const cp = repo.getCheckpoint(taskId);
  if (!cp) return;
  repo.clearCheckpoint(taskId);
  if (cp.ref.startsWith("refs/bob/checkpoint/")) {
    await git(["update-ref", "-d", cp.ref], cp.root || fallbackCwd || process.cwd(), deadline());
  }
}

/**
 * Revert a task to its stored checkpoint and record the outcome on the board. On success the
 * checkpoint is consumed (column cleared + pin ref deleted). Returns null if the task has no
 * checkpoint, else the RestoreOutcome (reverted:false = refused, left intact for a correct retry).
 */
export async function revertTaskToCheckpoint(
  cwd: string,
  taskId: number,
  actor: string,
  opts: { force?: boolean } = {},
): Promise<RestoreOutcome | null> {
  const cp = repo.getCheckpoint(taskId);
  if (!cp) return null;
  const signal = deadline();
  // Revert the repo the checkpoint came from, not the caller's cwd (a long-lived MCP server's
  // process.cwd() isn't necessarily the task's repo). restoreCheckpoint still verifies cp.root.
  const repoCwd = cp.root || cwd;
  const r = await restoreCheckpoint(repoCwd, cp, { ...opts, signal });
  if (r.reverted) {
    repo.addNote(taskId, `↩ Checkpoint rollback: ${r.note}.`, actor);
    await releaseCheckpoint(taskId, repoCwd);
  } else {
    repo.addNote(taskId, `Checkpoint rollback NOT applied: ${r.note}.`, actor);
  }
  return r;
}

export interface PreserveOutcome {
  /** True when partial work was committed to a branch (and the working tree restored clean). */
  preserved: boolean;
  /** The branch holding the preserved WIP, when preserved. */
  branch?: string;
  /** Human-readable detail: success, or why nothing was preserved. */
  note: string;
  /** The underlying restore (HEAD checks, removed files, recovery ref). */
  outcome?: RestoreOutcome;
}

/**
 * Create a branch pointing at `commitish` so a human can `git checkout` the preserved work. If the
 * branch already exists (an earlier preserve of the same task), suffix it (-2, -3, …) so prior WIP
 * is never clobbered. Returns the branch name, or undefined if the ref couldn't be resolved/written.
 */
async function createTaskBranch(cwd: string, taskId: number, commitish: string): Promise<string | undefined> {
  const signal = deadline();
  const sha = (await git(["rev-parse", commitish], cwd, signal)).stdout.trim();
  if (!sha) return undefined;
  let name = TASK_BRANCH(taskId);
  for (let n = 2; await refExists(`refs/heads/${name}`, cwd, signal); n++) {
    name = `${TASK_BRANCH(taskId)}-${n}`;
  }
  return (await git(["update-ref", `refs/heads/${name}`, sha], cwd, signal)).ok ? name : undefined;
}

/**
 * Checkpoint-before-death: on a terminal failure (idle trip, budget abort, wall-clock timeout,
 * crash), save the task's partial work to a dedicated `bob/task-<id>` branch and restore the working
 * tree to its pre-task checkpoint — so the dispatch never leaves uncommitted WIP on main. Builds on
 * restoreCheckpoint, which pins the pre-revert worktree (tracked AND untracked) to a recovery commit;
 * we alias that commit to a friendly branch. Returns preserved:false (no destruction) when there's no
 * checkpoint, the restore is refused (e.g. HEAD moved — the work is already committed), or there was
 * no WIP to save. Consumes the checkpoint on a successful restore. Best-effort: callers swallow throws.
 */
export async function preserveWipToBranch(
  cwd: string,
  taskId: number,
  actor: string,
  opts: { force?: boolean } & CheckpointOpts = {},
): Promise<PreserveOutcome> {
  const cp = repo.getCheckpoint(taskId);
  if (!cp) return { preserved: false, note: "no pre-task checkpoint (not a git repo, or checkpoints off)" };
  const signal = deadline(opts.signal);
  // Restore the repo the checkpoint came from (a long-lived server's cwd may differ); restoreCheckpoint
  // still verifies cp.root, refuses a moved HEAD, and pins the discarded state to a recovery ref.
  const repoCwd = cp.root || cwd;
  const r = await restoreCheckpoint(repoCwd, cp, { force: opts.force, signal });
  if (!r.reverted) {
    repo.addNote(taskId, `WIP not preserved: ${r.note}.`, actor);
    return { preserved: false, note: r.note, outcome: r };
  }
  // recoveryRef is undefined only when there was nothing to recover (worktree already matched the
  // checkpoint). Otherwise alias that pinned pre-revert commit to a discoverable task branch.
  const branch = r.recoveryRef ? await createTaskBranch(repoCwd, taskId, r.recoveryRef) : undefined;

  // Consume the checkpoint and drop its pin now that the pre-task state is restored. (The recovery
  // ref the branch points at is a separate ref, untouched by this.)
  await releaseCheckpoint(taskId, repoCwd);

  if (branch) {
    repo.addNote(
      taskId,
      `Preserved partial work to branch ${branch}; restored the working tree to its pre-task state.`,
      actor,
    );
    return { preserved: true, branch, note: `preserved to ${branch}`, outcome: r };
  }
  repo.addNote(taskId, "↩ No partial work to preserve; working tree was already at the pre-task state.", actor);
  return { preserved: false, note: "no WIP to preserve", outcome: r };
}

/**
 * Delete a task and drop its checkpoint pin ref, so a deleted task can't leak a pinned snapshot
 * gc can no longer reclaim. Returns repo.deleteTaskSafe's result; the ref is dropped only if the
 * delete happened. Recovery refs are kept on purpose (the undo-the-undo net) and pruned by hand.
 */
export async function deleteTaskAndCheckpoint(
  taskId: number,
  opts: { force?: boolean; cleanup?: boolean } = {},
): Promise<repo.DeleteSafeResult> {
  const cp = repo.getCheckpoint(taskId);
  const r = repo.deleteTaskSafe(taskId, opts);
  if (r.deleted && cp?.ref.startsWith("refs/bob/checkpoint/") && cp.root) {
    await git(["update-ref", "-d", cp.ref], cp.root, deadline());
  }
  return r;
}

type RecoveryPin = { ok: true; ref?: string } | { ok: false; reason: string };

/**
 * Pin the full current worktree state — tracked changes AND untracked (non-ignored) files — behind
 * a recovery ref so a revert is reversible. `git stash create` captures tracked changes only and
 * silently drops untracked files, so a task whose only change is a NEW file would be unrecoverable
 * after revert; snapshotWorktreeTree() builds an untracked-aware tree instead. ok without a ref when
 * there's nothing to recover (worktree == HEAD's tree); not ok, with git's reason, when the snapshot
 * can't be built or pinned — the caller must then refuse to revert.
 */
async function pinRecoverySnapshot(cwd: string, head: string | null, signal: AbortSignal): Promise<RecoveryPin> {
  const snap = await snapshotWorktreeTree(cwd, signal);
  if (!snap.tree) return { ok: false, reason: snap.error ?? "worktree snapshot failed" };
  if (signal.aborted) return { ok: false, reason: "git timed out after the snapshot" };
  // Nothing to recover if the snapshot matches HEAD's tree (no tracked or untracked change).
  if (head && snap.tree === (await git(["rev-parse", `${head}^{tree}`], cwd, signal)).stdout.trim())
    return { ok: true };
  // Commit the snapshot with a fixed identity so it works regardless of repo config, parented on
  // HEAD (none on an unborn branch), and pin it so gc can't reclaim the discarded work.
  const ident = {
    GIT_AUTHOR_NAME: "bob-recovery",
    GIT_AUTHOR_EMAIL: "bob@localhost",
    GIT_COMMITTER_NAME: "bob-recovery",
    GIT_COMMITTER_EMAIL: "bob@localhost",
  };
  const parent = head ? ["-p", head] : [];
  const ct = await git(
    ["commit-tree", snap.tree, ...parent, "-m", "bob pre-revert recovery snapshot"],
    cwd,
    signal,
    ident,
  );
  const commit = ct.stdout.trim();
  if (!ct.ok || !commit) return { ok: false, reason: gitFailure("commit-tree", ct, signal) };
  const ref = RECOVERY_REF(commit);
  const pinned = await git(["update-ref", ref, commit], cwd, signal);
  if (!pinned.ok) return { ok: false, reason: gitFailure("update-ref", pinned, signal) };
  return { ok: true, ref };
}

/** Remove now-empty directories upward from a removed file, stopping at the repo cwd. */
function pruneEmptyDirs(cwd: string, relFile: string): void {
  const stop = resolve(cwd);
  let dir = dirname(resolve(cwd, relFile));
  while (dir !== stop && dir.startsWith(stop)) {
    try {
      rmdirSync(dir);
    } catch {
      break; // non-empty or not removable → stop walking up
    }
    dir = dirname(dir);
  }
}
