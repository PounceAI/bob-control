// The done-integrity gate: the board's central safety invariant for "is this task actually done?".
// A read-only run terminates analysis_done; an implementation run reaches done ONLY with execution
// evidence (files/commit/test), else analysis_done — or done-UNVERIFIED when evidence couldn't be
// captured. Extracted from db.ts so the rule is a cohesive unit; it reuses db's primitives.
import type { Task } from "./types.js";
import { getTask, writeResult, addNote, recordArtifact, hasEvidence, closeOpenQuestions } from "./db.js";

/** Evidence that a task actually executed (vs. produced only analysis). */
export interface Evidence {
  /** Number of files changed (0 = no code written). */
  files_changed?: number;
  /** Paths changed — recorded as 'file' artifacts (absolute where possible, for cleanup). */
  files?: string[];
  /** Commit sha produced by the run. */
  commit?: string;
  /** Verification summary, e.g. "vitest: 42 passed". */
  test?: string;
  /** Human-readable diffstat. */
  diffstat?: string;
}

function evidenceHasChanges(e?: Evidence): boolean {
  if (!e) return false;
  return Boolean(
    (e.files_changed && e.files_changed > 0) ||
    (e.files && e.files.length > 0) ||
    (e.commit && e.commit.trim()) ||
    (e.test && e.test.trim()),
  );
}

function recordEvidenceArtifacts(taskId: number, e: Evidence): void {
  for (const f of e.files ?? []) recordArtifact(taskId, { kind: "file", path: f });
  if (e.commit && e.commit.trim()) recordArtifact(taskId, { kind: "commit", detail: e.commit.trim() });
  if (e.test && e.test.trim()) recordArtifact(taskId, { kind: "test", detail: e.test.trim() });
  // diffstat-only evidence stays a caller note, not a pathless 'file' artifact (would block delete).
}

export interface CompleteOptions {
  result: string;
  /** True when the resolved mode was read-only (ask/plan/review): never reaches done. */
  ranReadOnly: boolean;
  evidence?: Evidence;
  /** False when changes couldn't be checked (cwd not a git repo): impl-with-no-evidence is
   *  then marked done-UNVERIFIED, not demoted to analysis_done. Default true. */
  evidenceReliable?: boolean;
}

/**
 * Gated completion (worker + submit_result): read-only → analysis_done; impl+evidence → done;
 * impl+no-evidence → analysis_done, or done-UNVERIFIED when evidence wasn't checkable.
 */
export function completeTask(id: number, opts: CompleteOptions): Task | null {
  const task = getTask(id);
  if (!task) return null;
  // The run finished — close any still-open board question so a late answer can't resurrect this
  // task into a redundant re-dispatch (idempotency backstop). One call covers every terminal branch.
  closeOpenQuestions(id, "run completed");
  if (opts.evidence) recordEvidenceArtifacts(id, opts.evidence);

  // Read-only is a mode fact, reliable regardless of cwd.
  if (opts.ranReadOnly) {
    writeResult(id, opts.result, "analysis_done");
    return getTask(id);
  }

  const hasEv = evidenceHasChanges(opts.evidence) || hasEvidence(id);
  if (hasEv) {
    writeResult(id, opts.result, "done");
    return getTask(id);
  }
  if (opts.evidenceReliable === false) {
    // Couldn't verify changes — trust the completion, flag it, don't mismark as analysis_done.
    writeResult(id, opts.result, "done");
    addNote(
      id,
      "Completed; execution evidence could not be captured (working dir is not a git repo, or not the workspace that was edited) — marked done UNVERIFIED.",
      "worker",
    );
    return getTask(id);
  }
  writeResult(id, opts.result, "analysis_done");
  addNote(
    id,
    "Completed without execution evidence (no diff/commit/test recorded) — left as analysis_done; needs implementation/verification.",
    "worker",
  );
  return getTask(id);
}
