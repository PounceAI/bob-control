export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

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
}

export interface TaskNote {
  id: number;
  task_id: number;
  author: string | null;
  note: string;
  created_at: string;
}
