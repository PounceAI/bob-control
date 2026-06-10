// The await_task poll primitive: classify a task's current board state, for a caller blocking on it
// (a foreman / Claude after dispatching), into a discriminated outcome the MCP handler renders.
// Kept out of server.ts — which self-connects stdio on import — so it's unit-testable in isolation
// and the transport handler stays a thin switch over these cases. Sibling of questionState (the
// await_answer primitive) in questions.ts.
import { getTaskStatus, getOpenQuestion } from "./db.js";
import { isSettled } from "./types.js";
import type { TaskStatus } from "./types.js";

/** What one await_task poll observed. The handler maps each case to a tool response; the poll
 *  loop keeps waiting only while `unsettled`. */
export type AwaitTaskOutcome =
  | { kind: "missing" } // no such task — the caller awaited a deleted / never-created id
  | { kind: "unsettled"; status: TaskStatus } // staged/pending/in_progress — Bob is still driving it
  | { kind: "needs_input"; question: { question_id: string; text: string; options: string[] } | null } // parked on a question
  | { kind: "settled"; status: TaskStatus; result: string | null }; // done / analysis_done / blocked / cancelled

/**
 * Snapshot a task and classify it for an awaiter. Reads only status+result on the hot path
 * (getTaskStatus, not the full-row getTask), and the open question only when the task is parked
 * needs_input — where the caller needs the question text to answer it and await again.
 */
export function awaitTaskOutcome(taskId: number): AwaitTaskOutcome {
  const snap = getTaskStatus(taskId);
  if (!snap) return { kind: "missing" };
  if (!isSettled(snap.status)) return { kind: "unsettled", status: snap.status };
  if (snap.status === "needs_input") {
    const q = getOpenQuestion(taskId);
    return {
      kind: "needs_input",
      question: q ? { question_id: q.question_id, text: q.text, options: q.options } : null,
    };
  }
  return { kind: "settled", status: snap.status, result: snap.result };
}
