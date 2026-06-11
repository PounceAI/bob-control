export const TASK_STATUSES = [
  // staged: created but NOT pullable — released to pending deliberately (anti-race).
  "staged",
  "pending",
  "in_progress",
  // needs_input: a worker parked here while it waits for a human answer to a question
  // on the board (see task_questions). Non-pullable, non-terminal — resumes to in_progress
  // when answered, or parks to blocked if the question times out.
  "needs_input",
  "blocked",
  // analysis_done: terminal state for a read-only run (analysis/findings, no verified
  // implementation). Distinct from done so the board never shows green for unbuilt work.
  "analysis_done",
  "done",
  "cancelled",
] as const;

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** The only status a worker may claim/pull from. */
export const CLAIMABLE_STATUS: TaskStatus = "pending";

/** Successful terminal states. Both satisfy a dependency and count as "already completed". */
export const COMPLETED_STATUSES: readonly TaskStatus[] = ["done", "analysis_done"];

export function isCompleted(status: TaskStatus): boolean {
  return COMPLETED_STATUSES.includes(status);
}

/**
 * States where a worker is no longer actively driving a task forward on its own — an await_task
 * poll resolves here so the caller (Claude) can react the moment Bob settles. The transient
 * states (staged/pending/in_progress) keep the caller waiting. `needs_input` is settled-but-
 * actionable: the task can't progress until a human/Claude answers its board question, so we
 * surface it rather than block until the question's own timeout fires.
 */
export const SETTLED_STATUSES: readonly TaskStatus[] = ["done", "analysis_done", "blocked", "cancelled", "needs_input"];

export function isSettled(status: TaskStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

/**
 * Terminally finished: succeeded (done/analysis_done) or cancelled — the task will NOT run again.
 * Narrower than isSettled, which also includes the resumable/awaiting states `blocked` and
 * `needs_input`. Used to decide that a late question answer must not resurrect a finished run
 * into a redundant re-dispatch (see answerQuestion / closeOpenQuestions).
 */
export function isFinished(status: TaskStatus): boolean {
  return isCompleted(status) || status === "cancelled";
}

/** Kinds of execution artifact a worker can record against a task. */
export const ARTIFACT_KINDS = ["file", "commit", "test"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface TaskArtifact {
  id: number;
  task_id: number;
  /** 'file' = a path written/changed; 'commit' = a git sha; 'test' = a verification result. */
  kind: ArtifactKind;
  /** Filesystem path for kind 'file' (absolute where possible, for safe cleanup); else null. */
  path: string | null;
  /** Free-form detail: commit sha, diffstat, test summary. */
  detail: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  /** Bob mode slug (e.g. "code", "ask", "advanced", "orchestrator", or custom). null = dispatcher auto-routes. */
  mode: string | null;
  assignee: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  /** Task IDs this task depends on (must all be 'done' before this task is eligible). */
  depends_on: number[];
  /** Number of retry attempts made for transient failures (timeout/abort). */
  retry_attempts: number;
  /** Estimated single-dispatch output-token scope (see scope.ts), or null if not estimated.
   *  Set at creation; drives the worker's per-task token budget ceiling. */
  estimated_tokens: number | null;
}

export interface TaskNote {
  id: number;
  task_id: number;
  author: string | null;
  note: string;
  created_at: string;
}

/** A captured pre-task git state a task can be rolled back to (see src/checkpoint.ts). */
export interface TaskCheckpoint {
  /** Repo top-level the snapshot belongs to — restore refuses if cwd's repo differs. */
  root: string;
  /** HEAD sha at capture (null on an unborn branch) — restore refuses if HEAD has since moved. */
  head: string | null;
  /** Pinned ref (refs/bob/checkpoint/<id>) holding the snapshot commit, gc-safe; "" if none. */
  ref: string;
  /** Untracked files that already existed at capture (so task-created files can be told apart). */
  untracked: string[];
}

export const QUESTION_STATES = ["open", "answered", "timed_out"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

/** A human-input question a worker raised on the board, and its answer round-trip. */
export interface TaskQuestion {
  question_id: string;
  task_id: number;
  text: string;
  /** Optional multiple-choice answers. */
  options: string[];
  status: QuestionState;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  /** ISO deadline; past this an unanswered question times out and the task parks blocked. */
  deadline_at: string;
}
