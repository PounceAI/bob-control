export const TASK_STATUSES = [
  // staged: created but NOT pullable — released to pending deliberately (anti-race).
  "staged",
  "pending",
  "in_progress",
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
}

export interface TaskNote {
  id: number;
  task_id: number;
  author: string | null;
  note: string;
  created_at: string;
}
