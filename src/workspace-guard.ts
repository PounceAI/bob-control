// Layer-2 wrong-Bob guard: pure decision + message for the worker's workspace handshake (worker.ts owns
// the impure parking). Lives in its own module so it's unit-testable — worker.ts auto-runs main() on
// import, so its exports can't be pulled into a test. See docs/multi-instance-routing.md "layer 2".
import { sameWorkspace } from "./pipe-name.js";

export interface WorkspaceMismatch {
  /** The folder Bob reported having open. */
  reported: string;
  /** The worker's own workspace (its cwd). */
  expected: string;
}

/**
 * Compare the folder Bob reports having open against the worker's cwd. Returns a mismatch (→ refuse to
 * dispatch, park needs_input) or null when they match OR the workspace can't be learned — an unpatched
 * Bob yields null, leaving the guard inactive so the layer-1 pipe pairing still governs (don't block on
 * an unverifiable handshake).
 */
export function workspaceVerdict(reported: string | null, expected: string): WorkspaceMismatch | null {
  if (!reported) return null;
  return sameWorkspace(reported, expected) ? null : { reported, expected };
}

/** Board question parked when the worker is wired to the wrong Bob: names the instance it hit vs. the
 *  one expected and how to fix it, so a misroute is an obvious board failure, not a silent wrong edit. */
export function workspaceMismatchQuestion(m: WorkspaceMismatch): string {
  return (
    `Refused: this worker connected to the WRONG Bob — it has "${m.reported}" open, but this board/worker ` +
    `is for "${m.expected}". Dispatching would run git/edits against the wrong workspace. Re-launch this ` +
    `project's Bob + worker on the matching pipe (its ROO_CODE_IPC_SOCKET_PATH / bobTasks.pipe), then re-queue.`
  );
}
