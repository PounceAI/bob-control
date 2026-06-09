// Auto-retry policy for transient task failures (timeout/abort/idle). Extracted from
// the worker so it can be tested without a live Bob/IPC connection. When enabled
// (--retry flag), transient failures re-queue the task with exponential backoff
// instead of parking it blocked forever.

import type { DispatchResult } from "./bob-ipc.js";

export interface RetryPolicyDeps {
  /** Feature enabled via --retry flag. When false, no retries happen. */
  enabled: boolean;
  /** Maximum total attempts (initial + retries). E.g., 3 means: 1 initial + up to 2 retries. */
  maxAttempts: number;
  /** Current attempt count for this task (from task.retry_attempts). */
  currentAttempts: number;
  /** Task ID for logging/notes. */
  task: { id: number; title: string };
  /** Add a note to the task. */
  addNote: (taskId: number, note: string, author?: string) => void;
  /** Log a message. */
  log: (msg: string) => void;
  /** Injectable sleep for testing. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryDecision {
  /** Should the task be retried? */
  shouldRetry: boolean;
  /** Backoff delay in milliseconds (0 if no retry). */
  delayMs: number;
  /** Human-readable reason for the decision. */
  reason: string;
}

/**
 * Decide whether a failed dispatch should be retried. Only transient failures
 * (timeout/abort/idle) are eligible; others (budget abort, verification gave up,
 * dependency blocks) are NOT retried to avoid infinite loops.
 */
export function shouldRetry(result: DispatchResult, deps: RetryPolicyDeps): RetryDecision {
  // Feature off: never retry.
  if (!deps.enabled) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "retry feature disabled",
    };
  }

  // Only retry transient failures. timeout/aborted are transient; 'idle' is too — the idle watchdog
  // (shorter than the wall clock) now preempts what used to surface as a retryable 'timeout', so a
  // plain no-progress stall must stay retryable. (A blocked-on-ask idle is handled upstream as a
  // needs_input question and never reaches here.) 'budget' is NOT retried — a runaway that blew its
  // ceiling would just blow it again. Completed-but-unverified is handled by bob-polls, not here.
  const isTransient = result.status === "timeout" || result.status === "aborted" || result.status === "idle";
  if (!isTransient) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: `status '${result.status}' is not a transient failure`,
    };
  }

  // Check if we've hit the attempt cap. currentAttempts is the count BEFORE this
  // failure, so if currentAttempts + 1 >= maxAttempts, we've exhausted retries.
  const attemptsAfterThis = deps.currentAttempts + 1;
  if (attemptsAfterThis >= deps.maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: `attempt cap reached (${attemptsAfterThis}/${deps.maxAttempts})`,
    };
  }

  // Retry with exponential backoff: 5s, 10s, 20s, 40s, capped at 60s.
  // currentAttempts is 0-based (0 = first attempt), so the first RETRY (after
  // attempt 0 fails) uses 2^0 = 1 → 5s. The second retry uses 2^1 = 2 → 10s, etc.
  const baseDelayMs = 5000;
  const maxDelayMs = 60000;
  const delayMs = Math.min(baseDelayMs * Math.pow(2, deps.currentAttempts), maxDelayMs);

  return {
    shouldRetry: true,
    delayMs,
    reason: `transient '${result.status}' failure, retry ${attemptsAfterThis}/${deps.maxAttempts} after ${delayMs}ms`,
  };
}

/**
 * Execute a retry: sleep for the backoff delay, then return. The caller
 * (worker) will re-queue the task as pending after this returns.
 */
export async function executeRetry(decision: RetryDecision, deps: RetryPolicyDeps): Promise<void> {
  if (!decision.shouldRetry) return;

  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  deps.log(`  ⟳ retry: ${decision.reason}`);
  deps.addNote(deps.task.id, `Auto-retry: ${decision.reason}`, "retry-policy");

  if (decision.delayMs > 0) {
    deps.log(`  ⏱ waiting ${decision.delayMs}ms before retry…`);
    await sleep(decision.delayMs);
  }
}
