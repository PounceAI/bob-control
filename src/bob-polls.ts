// Verify-and-continue loop: after Bob completes a task, run an acceptance check
// and, if it fails, send the problem back to Bob to fix — looping until it passes
// or a sensible cap. This catches broken builds/tests and premature 'I am done'
// stops with no human present.
//
// Extracted from the worker so it can be tested without a live Bob/IPC connection.
// Mirrors the command-gate.ts pattern: injectable deps, unit-testable.

import { spawn } from "node:child_process";
import type { DispatchResult } from "./bob-ipc.js";
import { snapshotWorktreeTreeBounded } from "./git.js";

/**
 * The poll loop reads and passes a dispatch result straight through, so it IS a DispatchResult
 * (including the idle/budget statuses and the watchdog/budget fields the worker reads after the loop).
 * Aliased rather than re-declared so the two can't drift.
 */
export type PollResult = DispatchResult;

export interface VerifyResult {
  passed: boolean;
  reason: string;
}

export interface WorkCheckResult {
  didWork: boolean;
  reason: string;
}

export interface PollDeps {
  /** Feature toggle: when false, the loop is a no-op. */
  enabled: boolean;
  /** Optional command to run for verification (exit 0 = pass). */
  verifyCommand?: string;
  /** Max number of continue attempts before giving up. */
  maxContinues: number;
  /** Working directory for the verify command. */
  cwd: string;
  /** The original task prompt, re-sent (with the failure) on a continue so Bob has full context. */
  taskPrompt: string;
  /** Task metadata for logging/notes. */
  task: { id: number; title: string };
  addNote: (taskId: number, note: string, author?: string) => void;
  log: (msg: string) => void;
  /** Injectable for tests; defaults to the real verifier. */
  verify?: (result: string, command: string | undefined, cwd: string) => Promise<VerifyResult>;
  /** Injectable for tests; defaults to the real dispatcher. */
  dispatch?: (text: string) => Promise<PollResult>;
  /** Feature toggle for plan-stop detection: when true, check if Bob did real work. */
  detectPlanStop?: boolean;
  /** Injectable for tests; captures a snapshot of the working tree state. */
  captureSnapshot?: (cwd: string) => Promise<string>;
  /** Injectable for tests; checks if real work happened (snapshot changed from baseline). */
  checkDidWork?: (cwd: string, baseline: string) => Promise<WorkCheckResult>;
}

/**
 * Run the verification check by executing the verify command (exit 0 = pass).
 * With no command AND no judge verifier, there's nothing reliable to check — scanning
 * the result text for words like "error" false-positives on benign mentions ("added
 * error handling"), so we conservatively PASS rather than trigger a spurious continue.
 * Exported so the composite verifier in worker.ts can reuse this logic.
 */
export async function defaultVerify(
  _result: string,
  command: string | undefined,
  cwd: string,
  timeoutMs = 300_000,
): Promise<VerifyResult> {
  if (!command) return { passed: true, reason: "no verify command — not checked" };
  // Run the verify command; exit code 0 = pass, non-zero = fail. A timeout kills the process and
  // fails the check, so a hanging command (a watcher, a credential prompt) can't wedge the worker.
  return new Promise<VerifyResult>((resolve) => {
    const proc = spawn(command, { shell: true, cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: VerifyResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
      finish({ passed: false, reason: `verify command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        finish({ passed: true, reason: "verify command exited 0" });
      } else {
        const out = (stdout + stderr).trim().slice(0, 200);
        finish({ passed: false, reason: `verify command exited ${code}${out ? `: ${out}` : ""}` });
      }
    });
    proc.on("error", (err: Error) => {
      finish({ passed: false, reason: `verify command failed to run: ${err.message}` });
    });
  });
}

/**
 * Working-tree snapshot as a single untracked-aware tree sha: two shas differ iff content changed —
 * including edits to files that stay untracked, which a `git status`/`git diff` pair misses (status
 * shows the same `??`, diff omits untracked content). null (non-git, git failure, timeout) → GIT_ERROR,
 * which checkDidWork reads as "assume work done" over a false plan-stop.
 */
export async function defaultCaptureSnapshot(cwd: string, timeoutMs = 30_000): Promise<string> {
  return (await snapshotWorktreeTreeBounded(cwd, timeoutMs)) ?? "GIT_ERROR";
}

/**
 * Check if real work happened by comparing the current snapshot to a baseline.
 * Returns didWork=false if the snapshot is unchanged (no new changes since baseline),
 * meaning Bob likely just presented a plan without implementing it.
 */
async function defaultCheckDidWork(cwd: string, baseline: string): Promise<WorkCheckResult> {
  const current = await defaultCaptureSnapshot(cwd);

  // Git command failed: conservatively assume work happened.
  if (current === "GIT_ERROR" || baseline === "GIT_ERROR") {
    return { didWork: true, reason: "git check failed, assuming work done" };
  }

  if (current === baseline) {
    return { didWork: false, reason: "working tree unchanged from baseline (no new changes)" };
  }
  return { didWork: true, reason: "working tree changed since baseline" };
}

/**
 * Build the verify-and-continue loop handler. Returns a function that takes the
 * initial dispatch result and either returns it (if verification passes) or loops
 * with Bob to fix issues until it passes or the max-continues cap is hit.
 */
export function createPollLoop(deps: PollDeps): (initial: PollResult, baseline?: string) => Promise<PollResult> {
  // The injected verify function (if provided) is the judge verifier.
  // When not provided, we use defaultVerify which handles command execution.
  const verify = deps.verify ?? defaultVerify;
  const captureSnapshot = deps.captureSnapshot ?? defaultCaptureSnapshot;
  const checkDidWork = deps.checkDidWork ?? defaultCheckDidWork;

  return async function pollLoop(initial: PollResult, baseline?: string): Promise<PollResult> {
    // Feature off: return the initial result unchanged.
    if (!deps.enabled) return initial;

    // No result captured (aborted/timeout): can't verify, return as-is.
    if (!initial.result.trim()) {
      deps.log(`  [bob-polls] no result to verify — skipping verification`);
      return initial;
    }

    deps.log(`  [bob-polls] verifying result (max ${deps.maxContinues} continues)…`);
    let current = initial;
    let continueCount = 0;

    // Capture baseline snapshot if plan-stop detection is on and no baseline provided
    let currentBaseline = baseline;
    if (deps.detectPlanStop && !currentBaseline) {
      currentBaseline = await captureSnapshot(deps.cwd);
    }

    while (continueCount <= deps.maxContinues) {
      // Plan-stop detection: check if Bob did real work (snapshot changed from baseline).
      // This catches "I presented a plan" completions with no code written.
      if (deps.detectPlanStop && currentBaseline) {
        const { didWork, reason: workReason } = await checkDidWork(deps.cwd, currentBaseline);
        if (!didWork) {
          // No work detected: treat as a verification failure and continue.
          if (continueCount >= deps.maxContinues) {
            deps.log(`  [bob-polls] ✗ plan-stop detected after ${deps.maxContinues} continue(s) — giving up`);
            deps.addNote(
              deps.task.id,
              `Plan-stop: Bob completed with no code changes after ${deps.maxContinues} continue(s). ${workReason}`,
              "bob-polls",
            );
            return { ...current, status: "aborted" };
          }

          continueCount++;
          deps.log(`  [bob-polls] ✗ plan-stop detected (${workReason}) — continue #${continueCount}`);
          deps.addNote(deps.task.id, `Continue #${continueCount}: plan-stop (${workReason})`, "bob-polls");

          if (!deps.dispatch) {
            throw new Error("bob-polls: dispatch function not provided (required for continues)");
          }
          const continuePrompt = `${deps.taskPrompt}\n\n---\nYou presented a plan but did NOT implement it. The working tree has no changes.\nImplement the code and complete the task.`;
          current = await deps.dispatch(continuePrompt);

          if (!current.result.trim()) {
            deps.log(`  [bob-polls] continue #${continueCount} produced no result — stopping`);
            deps.addNote(
              deps.task.id,
              `Continue #${continueCount} produced no result (${current.status})`,
              "bob-polls",
            );
            return current;
          }
          // Re-capture baseline after continue so we can detect if THIS continue did work
          currentBaseline = await captureSnapshot(deps.cwd);
          // Loop back to check work again (and then verify if work was done).
          continue;
        }
        // Work detected: proceed to verification.
        deps.log(`  [bob-polls] work detected (${workReason})`);
      }

      const { passed, reason } = await verify(current.result, deps.verifyCommand, deps.cwd);

      if (passed) {
        if (continueCount === 0) {
          deps.log(`  [bob-polls] ✓ verified on first try (${reason})`);
          deps.addNote(deps.task.id, `Verified on first try: ${reason}`, "bob-polls");
        } else {
          deps.log(`  [bob-polls] ✓ verified after ${continueCount} continue(s) (${reason})`);
          deps.addNote(deps.task.id, `Verified after ${continueCount} continue(s): ${reason}`, "bob-polls");
        }
        return current;
      }

      // Verification failed.
      if (continueCount >= deps.maxContinues) {
        // Hit the cap: give up and return the last result as a failure.
        deps.log(`  [bob-polls] ✗ verification failed after ${deps.maxContinues} continue(s) — giving up`);
        deps.addNote(
          deps.task.id,
          `Verification failed after ${deps.maxContinues} continue(s). Last failure: ${reason}`,
          "bob-polls",
        );
        // Return the last result but mark it as failed (caller will handle blocking).
        return { ...current, status: "aborted" };
      }

      // Re-dispatch with the FULL original task plus the failure, so Bob has the
      // context to actually fix it — a bare "fix it" with no task is useless, and a
      // post-completion sendMessage is a no-op (no active dispatch to receive it).
      continueCount++;
      deps.log(`  [bob-polls] ✗ verification failed (${reason}) — continue #${continueCount}`);
      deps.addNote(deps.task.id, `Continue #${continueCount}: ${reason}`, "bob-polls");

      if (!deps.dispatch) {
        throw new Error("bob-polls: dispatch function not provided (required for continues)");
      }
      const continuePrompt = `${deps.taskPrompt}\n\n---\nYour previous attempt did NOT pass verification: ${reason}\nFix the problem and complete the task again.`;
      current = await deps.dispatch(continuePrompt);

      // If Bob aborted/timed out on the continue, stop looping.
      if (!current.result.trim()) {
        deps.log(`  [bob-polls] continue #${continueCount} produced no result — stopping`);
        deps.addNote(deps.task.id, `Continue #${continueCount} produced no result (${current.status})`, "bob-polls");
        return current;
      }

      // Re-capture baseline after continue so we can detect if THIS continue did work
      if (deps.detectPlanStop) {
        currentBaseline = await captureSnapshot(deps.cwd);
      }
    }

    // Should never reach here, but return the last result as a fallback.
    return current;
  };
}
