import type { BobDriver } from "./bob-driver.js";
import type { DispatchResult } from "./bob-ipc.js";
import { type Opts, pickEligible } from "./worker.js";
import * as repo from "./db.js";
import { resolveMode, profileFor, isReadOnlyMode } from "./modes.js";
import { preserveWipToBranch } from "./checkpoint.js";
import { captureGitBaseline, captureChangedFiles, type GitBaseline } from "./judge.js";
import { shouldRetry, executeRetry } from "./retry-policy.js";
import { createPollLoop, defaultCaptureSnapshot } from "./bob-polls.js";
import type { Task } from "./types.js";

// V5 tail: the transport-agnostic board-drain loop the EXTENSION HOST runs in-process for Bob 2.0 (the
// 2.0 driver can't be a child process — see docs/bob-2-inprocess.md). It drives any BobDriver, so the
// same loop serves a future refactor of the 1.x path. This is the MVP analog of worker.ts's runOne MINUS
// the IPC-only gate layer (command/permission/mode-switch/followup): on 2.0 auto-approve is config-driven
// (V4) and there is no event stream to gate on. Defer-while-chatting is not ported. Verify-and-continue
// IS (command-verify + plan-stop, both transport-agnostic via bob-polls); the LLM judge is not yet —
// it needs the classifier backend threaded into the in-process loop (follow-up).

export interface DriverLoopConfig {
  driver: BobDriver;
  opts: Opts;
  /** Project root for git evidence / checkpoint ops. In the extension host this is the open workspace
   *  folder, NOT process.cwd() (which is Bob's dir). Tests pass a non-git temp dir so the git ops no-op. */
  cwd: string;
  log?: (msg: string) => void;
  emit?: (type: string, data: Record<string, unknown>) => void;
  /** Delay primitive for retry backoff + idle poll; injectable so tests run without real waits. */
  sleep?: (ms: number) => Promise<void>;
}

function buildPrompt(task: Task): string {
  const header = `Task #${task.id}: ${task.title}`;
  const body = task.description?.trim() ? `\n\n${task.description.trim()}` : "";
  return header + body;
}

/** Board note for Bob's run cost + stall telemetry, or "" if neither is known. `maxIdleMs` (the worst
 *  silent-but-running gap) accumulates the evidence for a future stall-watchdog threshold. */
function usageNote(res: DispatchResult): string {
  const bits: string[] = [];
  if (res.tokensUsed) bits.push(`~${res.tokensUsed} output tokens`);
  if (res.maxIdleMs) bits.push(`max idle ${Math.round(res.maxIdleMs / 1000)}s between updates`);
  return bits.length ? `Bob usage: ${bits.join(", ")}.` : "";
}

/**
 * Drive ONE eligible task through the driver: route → claim → dispatch → finalize. Returns true if a task
 * was processed, false if the board had nothing eligible (empty / all risk-gated / dependency-blocked).
 * Never throws — a dispatch failure is captured as a terminal result and the task is blocked or retried.
 */
export async function driveOnce(cfg: DriverLoopConfig): Promise<boolean> {
  const { driver, opts, cwd } = cfg;
  const log = cfg.log ?? (() => {});
  const { task } = pickEligible(opts);
  if (!task) return false;

  const { mode, source } = resolveMode(task);
  const profile = profileFor(mode);
  log(`▶ #${task.id} "${task.title}" → mode {${mode}} (${source}, risk:${profile.risk})`);
  cfg.emit?.("taskStart", { id: task.id, title: task.title, mode, risk: profile.risk });
  if (opts.dryRun) {
    log(`  [dry-run] would claim @${opts.assignee} and dispatch`);
    return true;
  }
  if (!repo.claimTask(task.id, opts.assignee)) {
    log(`  (#${task.id} vanished before claim — skipping)`);
    return true;
  }
  repo.addNote(
    task.id,
    `Auto-dispatched (in-process 2.0 driver) in mode {${mode}} (${source}, risk:${profile.risk}).`,
    "worker",
  );

  const baseline = await gitBaseline(cwd);
  // Plan-stop baseline: a working-tree snapshot taken BEFORE the dispatch, so the poll loop can tell a
  // plan-only completion (no new changes) from real work. Only needed when verify-and-continue runs it.
  const planStopBaseline = opts.verifyAndContinue && opts.detectPlanStop ? await snapshot(cwd) : undefined;
  let res: DispatchResult;
  try {
    res = await driver.dispatch({ text: buildPrompt(task), mode, timeoutMs: opts.timeoutMs });
  } catch (e) {
    // BobDriver.dispatch is contracted never to reject; stay defensive for a third-party driver.
    res = { taskId: null, result: "", lastText: (e as Error).message, status: "aborted", tokensUsed: 0, turns: 0 };
  }
  res = await verifyAndContinue(cfg, task, mode, res, planStopBaseline);
  await finalize(cfg, task, mode, res, baseline);
  return true;
}

/**
 * Verify-and-continue for the 2.0 loop: after the initial dispatch, run the acceptance check (the
 * --verify-command, plus --detect-plan-stop) and, on failure, re-dispatch the task + the failure via the
 * driver until it passes or --max-continues is hit. Reuses the transport-agnostic bob-polls loop with the
 * 2.0 driver as its dispatcher. No-op when --verify-and-continue is off. The LLM judge is NOT wired here
 * yet (it needs the classifier backend in the in-process loop) — command + plan-stop only.
 */
async function verifyAndContinue(
  cfg: DriverLoopConfig,
  task: Task,
  mode: string,
  initial: DispatchResult,
  planStopBaseline: string | undefined,
): Promise<DispatchResult> {
  const { driver, opts, cwd } = cfg;
  if (!opts.verifyAndContinue) return initial;
  const loop = createPollLoop({
    enabled: true,
    verifyCommand: opts.verifyCommand,
    maxContinues: opts.maxContinues,
    cwd,
    taskPrompt: buildPrompt(task),
    task: { id: task.id, title: task.title },
    addNote: repo.addNote,
    log: cfg.log ?? (() => {}),
    dispatch: (text: string) => driver.dispatch({ text, mode, timeoutMs: opts.timeoutMs }),
    detectPlanStop: opts.detectPlanStop,
  });
  return loop(initial, planStopBaseline);
}

/** Record a genuine completion (with file evidence), else retry a transient failure or preserve WIP + block. */
async function finalize(
  cfg: DriverLoopConfig,
  task: Task,
  mode: string,
  res: DispatchResult,
  baseline?: GitBaseline,
): Promise<void> {
  const { opts, cwd } = cfg;
  const log = cfg.log ?? (() => {});

  // Gate completion on the status, NOT on result text: the verify-and-continue loop returns Bob's last
  // (non-empty) result with status 'aborted' when it gives up, and that must block, not falsely complete.
  if (res.status === "completed") {
    const result = res.result.trim() || "(completed; no result text captured on 2.0)";
    const ranReadOnly = isReadOnlyMode(mode);
    const changed = await changedFiles(cwd, baseline);
    for (const f of changed.created)
      repo.recordArtifact(task.id, { kind: "file", path: f, detail: ranReadOnly ? "side-effect" : "created" });
    for (const f of changed.modified)
      repo.recordArtifact(task.id, { kind: "file", path: f, detail: ranReadOnly ? "side-effect" : "modified" });
    if (changed.diffstat)
      repo.addNote(task.id, `Changed ${changed.count} file(s) (evidence):\n${changed.diffstat}`, "worker");
    const usage = usageNote(res);
    if (usage) repo.addNote(task.id, usage, "worker");
    const completed = repo.completeTask(task.id, { result, ranReadOnly, evidenceReliable: changed.gitAvailable });
    if (task.retry_attempts > 0) repo.resetRetryAttempts(task.id);
    const finalStatus = completed?.status ?? "done";
    log(`  ✓ ${finalStatus} — ${changed.count} file(s) changed, result captured (${result.length} chars)`);
    cfg.emit?.("taskDone", { id: task.id, title: task.title, status: finalStatus, filesChanged: changed.count });
    return;
  }

  // Non-success. Retry a transient failure (timeout/abort) if enabled, else preserve WIP and block.
  const retryDeps = {
    enabled: opts.retry,
    maxAttempts: opts.maxRetryAttempts,
    currentAttempts: task.retry_attempts,
    task: { id: task.id, title: task.title },
    addNote: repo.addNote,
    log,
    sleep: cfg.sleep,
  };
  const decision = shouldRetry(res, retryDeps);
  if (decision.shouldRetry) {
    repo.incrementRetryAttempts(task.id);
    await executeRetry(decision, retryDeps);
    repo.updateStatus(task.id, "pending");
    log(`  ↻ #${task.id} re-queued for retry`);
    cfg.emit?.("taskRetry", { id: task.id, title: task.title, attempt: task.retry_attempts + 1 });
    return;
  }
  const branch = await preserveWip(opts, cwd, task.id);
  repo.updateStatus(task.id, "blocked");
  const branchNote = branch ? ` Partial work preserved to ${branch}.` : "";
  const detail = res.lastText.trim() ? `: ${res.lastText.trim().replace(/\s+/g, " ").slice(0, 140)}` : "";
  const idleNote = res.maxIdleMs ? ` Max idle ${Math.round(res.maxIdleMs / 1000)}s between updates.` : "";
  repo.addNote(task.id, `Dispatch ended '${res.status}'${detail}.${branchNote}${idleNote}`, "worker");
  log(`  ✗ #${task.id} ${res.status} — marked blocked`);
  cfg.emit?.("taskFail", { id: task.id, title: task.title, status: res.status, branch });
}

/**
 * Drain the board, then idle-poll for more — the long-running loop the extension starts/stops. Honors the
 * board-armed gate and the --once flag; `shouldStop` lets the host cancel between tasks. Lease/heartbeat
 * and defer-while-chatting are the 1.x worker's job and not ported here (one extension = one loop/window).
 */
export async function runDriverLoop(cfg: DriverLoopConfig, shouldStop: () => boolean = () => false): Promise<void> {
  const { opts } = cfg;
  const log = cfg.log ?? (() => {});
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    await cfg.driver.connect();
  } catch (e) {
    log(`driver connect failed: ${(e as Error).message}`);
    cfg.emit?.("error", { message: (e as Error).message });
    return;
  }
  cfg.emit?.("connected", { maxRisk: opts.maxRisk });
  while (!shouldStop()) {
    if (!repo.isBoardArmed()) {
      if (opts.once) break;
      cfg.emit?.("idle", { disarmed: true });
      await sleep(opts.pollMs);
      continue;
    }
    let processed = false;
    try {
      processed = await driveOnce(cfg);
    } catch (e) {
      log(`loop error: ${(e as Error).message}`); // driveOnce shouldn't throw, but never let the loop die
    }
    if (processed) {
      if (opts.once) break;
      continue; // pull the next immediately while the board has work
    }
    if (opts.once) break;
    cfg.emit?.("idle", {});
    await sleep(opts.pollMs);
  }
  cfg.driver.close();
  cfg.emit?.("stopped", {});
}

// Git evidence/checkpoint are best-effort: a non-git cwd (or a transient git error) must never fail a
// dispatch's bookkeeping, so each is wrapped to a safe default.
async function gitBaseline(cwd: string): Promise<GitBaseline | undefined> {
  try {
    return await captureGitBaseline(cwd);
  } catch {
    return undefined;
  }
}
/** Pre-dispatch working-tree snapshot for plan-stop detection. On any failure return the GIT_ERROR
 *  sentinel (which checkDidWork reads as "assume work done"), never undefined — an undefined baseline
 *  would make the poll loop re-snapshot POST-dispatch and false-trigger a plan-stop. */
async function snapshot(cwd: string): Promise<string> {
  try {
    return await defaultCaptureSnapshot(cwd);
  } catch {
    return "GIT_ERROR";
  }
}
async function changedFiles(cwd: string, baseline?: GitBaseline) {
  try {
    return await captureChangedFiles(cwd, baseline);
  } catch {
    return { created: [], modified: [], diffstat: "", count: 0, gitAvailable: false };
  }
}
async function preserveWip(opts: Opts, cwd: string, taskId: number): Promise<string | undefined> {
  if (!opts.checkpoint) return undefined;
  try {
    return (await preserveWipToBranch(cwd, taskId, "worker")).branch;
  } catch {
    return undefined;
  }
}
