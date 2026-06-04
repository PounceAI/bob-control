#!/usr/bin/env node
import "./suppress-warnings.js";
import * as repo from "./db.js";
import {
  resolveMode,
  profileFor,
  dispatchAutoApprove,
  RISK_RANK,
  MODE_PROFILES,
  classifierReachable,
  policyHasGrayZone,
  producesReviewFindings,
  judgeAppliesToMode,
  isReadOnlyMode,
  type Risk,
} from "./modes.js";
import { createCommandGate } from "./command-gate.js";
import { createFollowupGate } from "./followup-gate.js";
import { handleStdinAnswer } from "./worker-answer.js";
import { BobClient, resolvePipe, type DispatchResult } from "./bob-ipc.js";
import { formatReviewFindings, parseReviewFindings } from "./review-findings.js";
import { createPollLoop, defaultVerify, defaultCaptureSnapshot, type VerifyResult } from "./bob-polls.js";
import { ExternalActivity } from "./defer.js";
import { notify } from "./notify.js";
import { shouldRetry, executeRetry } from "./retry-policy.js";
import {
  judgeCompletion,
  captureGitDiff,
  captureGitBaseline,
  captureChangedFiles,
  type JudgeContext,
  type GitBaseline,
} from "./judge.js";
import { captureCheckpoint, revertTaskToCheckpoint } from "./checkpoint.js";
import type { Task } from "./types.js";
import { isCompleted } from "./types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Best-effort check that tools/patch-bob-buttons.mjs is applied — without it Bob
 * drops approve/reject presses and classified commands stall. null = can't locate
 * the bundle (don't warn).
 */
function buttonPatchPresent(): boolean | null {
  try {
    const target = join(
      process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"),
      "Programs",
      "IBM Bob",
      "resources",
      "app",
      "extensions",
      "bob-code",
      "dist",
      "extension.js",
    );
    return readFileSync(target, "utf8").includes('"PressPrimaryButton"');
  } catch {
    return null;
  }
}

/**
 * Auto-dispatch loop. Polls the task board for the highest-priority pending
 * task, routes it to a Bob mode (see modes.ts), dispatches over IPC (same-tab,
 * no focus steal), waits for completion, writes completion_result back, then
 * grabs the next. One task at a time.
 *
 *   node dist/worker.js                 drain the board, then idle-poll for more
 *   node dist/worker.js --once          do a single task (or exit if none) and stop
 *   node dist/worker.js --tag rpg       only take tasks with this tag
 *   node dist/worker.js --surface newTab open each task in a new editor tab (steals focus)
 *   node dist/worker.js --max-risk safe only run safe (read-only) tasks unattended
 *   node dist/worker.js --no-notify     silence the per-task desktop toast/sound/bell
 *   node dist/worker.js --no-defer      don't pause while you're chatting with Bob
 *   node dist/worker.js --dry-run       show routing/claims without dispatching to Bob
 *   node dist/worker.js --answer-followups  let Claude answer Bob's questions (else they wait for you)
 *   node dist/worker.js --escalate-all      escalate all followup questions to human review (with --answer-followups)
 *   node dist/worker.js --verify-and-continue  verify result and loop with Bob until it passes
 *   node dist/worker.js --detect-plan-stop     catch plan-only completions (no code written) and auto-continue
 *   node dist/worker.js --emit-json     also print @@WORKER {json} event lines (for the extension)
 *   node dist/worker.js --retry 3       auto-retry transient failures (timeout/abort) up to 3 total attempts
 * Flags: --pipe <path>  --poll <ms>  --timeout <ms>  --assignee <name>  --defer-idle <ms>
 *        --verify-command <cmd>  --max-continues <n>  --retry <max-attempts>
 *
 * Each mode has a risk level (safe < standard < elevated); only tasks at or
 * below --max-risk are dispatched. While the user is chatting with Bob, dispatch
 * is held (a same-tab dispatch would abort the live chat) until the chat has
 * been idle for --defer-idle ms.
 *
 * With --verify-and-continue, after Bob completes a task, the worker runs an
 * acceptance check (--verify-command or built-in heuristics) and, if it fails,
 * sends the problem back to Bob to fix — looping until it passes or --max-continues
 * is reached. This catches broken builds/tests without human intervention.
 *
 * With --detect-plan-stop, the worker checks if Bob did real work (git working-tree
 * changed) after completion. If the tree is clean (plan-only, no code written), it
 * treats this as a failure and auto-continues, asking Bob to implement the plan.
 */

interface Opts {
  once: boolean;
  newTab: boolean;
  dryRun: boolean;
  notify: boolean;
  defer: boolean;
  deferIdleMs: number;
  deferStaleMs: number;
  commandClassifier: boolean;
  answerFollowups: boolean;
  escalateAll: boolean;
  reviewPlans: boolean;
  classifierBackend: "api" | "cli";
  classifierModel?: string;
  classifierCli?: string;
  emitJson: boolean;
  tag?: string;
  pipe?: string;
  pollMs: number;
  timeoutMs: number;
  assignee: string;
  maxRisk: Risk;
  verifyAndContinue: boolean;
  verifyCommand?: string;
  verifyJudge: boolean;
  maxContinues: number;
  detectPlanStop: boolean;
  retry: boolean;
  maxRetryAttempts: number;
  allowCommands: string[];
  /** Capture a pre-task git checkpoint and auto-revert on a clean-fail terminal. */
  checkpoint: boolean;
}

function parseOpts(argv: string[]): Opts {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  // Numeric flag with a default; fail loud rather than coerce a bad value to NaN
  // (NaN timeouts fire instantly and NaN comparisons are always false).
  const num = (name: string, dflt: number): number => {
    const v = val(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      console.error(`invalid ${name} '${v}' (expected a number)`);
      process.exit(1);
    }
    return n;
  };
  const maxRisk = (val("--max-risk") ?? "standard") as Risk;
  if (!(maxRisk in RISK_RANK)) {
    console.error(`invalid --max-risk '${maxRisk}' (use safe | standard | elevated)`);
    process.exit(1);
  }
  // --new-tab is an alias for --surface newTab.
  const surface = val("--surface");
  const newTab = has("--new-tab") || surface === "newTab";
  const maxRetryAttempts = num("--retry", 0);
  // Parse --allow-commands: comma-separated prefixes to extend the allowlist.
  const allowCommandsStr = val("--allow-commands");
  const allowCommands = allowCommandsStr
    ? allowCommandsStr
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  return {
    once: has("--once"),
    newTab,
    dryRun: has("--dry-run"),
    notify: !has("--no-notify"),
    defer: !has("--no-defer"),
    deferIdleMs: num("--defer-idle", 60_000),
    deferStaleMs: num("--defer-stale", 5 * 60_000),
    commandClassifier: has("--command-classifier"),
    answerFollowups: has("--answer-followups"),
    escalateAll: has("--escalate-all"),
    reviewPlans: has("--review-plans"),
    classifierBackend: val("--classifier-backend") === "api" ? "api" : "cli",
    classifierModel: val("--classifier-model"),
    classifierCli: val("--classifier-cli"),
    emitJson: has("--emit-json"),
    tag: val("--tag"),
    pipe: val("--pipe"),
    pollMs: num("--poll", 3000),
    timeoutMs: num("--timeout", 300_000),
    assignee: val("--assignee") ?? "bob",
    maxRisk,
    verifyAndContinue: has("--verify-and-continue"),
    verifyCommand: val("--verify-command"),
    verifyJudge: has("--verify-judge"),
    maxContinues: num("--max-continues", 3),
    detectPlanStop: has("--detect-plan-stop"),
    retry: maxRetryAttempts > 0,
    maxRetryAttempts,
    allowCommands,
    checkpoint: has("--checkpoint"),
  };
}

/**
 * On a clean-fail terminal, roll a task's tree back to its pre-task checkpoint. Opt-in
 * (--checkpoint); no-op without a checkpoint or outside a git repo. A committed task is refused
 * (won't rewrite history) and only logged — recover with `bob revert <id> --force`. Best-effort:
 * never throws into the worker's terminal handling.
 */
async function revertIfEnabled(opts: Opts, taskId: number): Promise<void> {
  if (!opts.checkpoint) return;
  try {
    const r = await revertTaskToCheckpoint(process.cwd(), taskId, "worker");
    if (r?.reverted) console.log(`  ↩ #${taskId} rolled back to pre-task checkpoint (${r.note})`);
    else if (r) console.log(`  ⚠ #${taskId} checkpoint NOT rolled back: ${r.note}`);
  } catch (err) {
    console.log(`  ⚠ #${taskId} checkpoint rollback errored: ${(err as Error).message}`);
  }
}

/**
 * Check if a task's dependencies are all satisfied (all must be 'done').
 * Returns null if satisfied, or a description of blocking dependencies if not.
 */
function checkDependencies(task: Task): string | null {
  // Delegate to the shared classifier so 'analysis_done' counts as satisfied (an analysis
  // prerequisite legitimately finishes there; strict 'done' would deadlock analyze→implement).
  return repo.blockingDependencies(task);
}

/**
 * Highest-priority pending task whose mode's risk is at or below the gate
 * and whose dependencies are all satisfied.
 * Returns the task plus counts of tasks skipped due to risk gate or blocked dependencies.
 */
function pickEligible(opts: Opts): { task: Task | null; gated: number; blocked: number } {
  const max = RISK_RANK[opts.maxRisk];
  const pending = repo.listTasks({ status: "pending", tag: opts.tag });
  let gated = 0;
  let blocked = 0;
  let task: Task | null = null;

  for (const t of pending) {
    // Check dependencies first
    const depBlock = checkDependencies(t);
    if (depBlock) {
      console.log(`  skipping #${t.id} (blocked on ${depBlock})`);
      blocked++;
      continue;
    }

    // Then check risk gate
    const { mode } = resolveMode(t);
    if (RISK_RANK[profileFor(mode).risk] <= max) {
      task = t;
      break;
    }
    gated++;
  }

  return { task, gated, blocked };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(task: Task): string {
  const header = `Task #${task.id}: ${task.title}`;
  const body = task.description?.trim() ? `\n\n${task.description.trim()}` : "";
  return header + body;
}

/** Structured event for the extension (parsed from stdout lines). */
function emit(opts: Opts, type: string, data: Record<string, unknown> = {}): void {
  if (opts.emitJson) console.log(`@@WORKER ${JSON.stringify({ type, ...data })}`);
}

/** Global registry of active followup gates, keyed by task ID. */
const activeFollowupGates = new Map<number, ReturnType<typeof createFollowupGate>>();

async function runOne(client: BobClient, task: Task, opts: Opts): Promise<void> {
  const { mode, source } = resolveMode(task);
  const profile = profileFor(mode);
  console.log(`\n▶ #${task.id} "${task.title}" → mode {${mode}} (${source}, risk:${profile.risk})`);
  emit(opts, "taskStart", { id: task.id, title: task.title, mode, risk: profile.risk });

  if (opts.dryRun) {
    console.log(`  [dry-run] would claim as @${opts.assignee} and dispatch`);
    return;
  }

  // Task may have been deleted between pickEligible() and now; claimTask returns
  // null if it's gone, so skip rather than dispatch stale data.
  if (!repo.claimTask(task.id, opts.assignee)) {
    console.log(`  (task #${task.id} vanished before claim — skipping)`);
    return;
  }
  repo.addNote(task.id, `Auto-dispatched in mode {${mode}} (${source}, risk:${profile.risk}).`, "worker");

  // Gray-zone command approval: under allowlist or classifier policy, commands that
  // miss Bob's static allowlist surface as an `ask` instead of auto-running. Rather
  // than wait for a human, ask Claude and press approve/reject over IPC (needs the
  // Bob button patch). Fail-safe: only an explicit "approve" runs the command.
  const classifierOn = opts.commandClassifier && policyHasGrayZone(profile.commandPolicy);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // The api backend can't run without a key; the cli backend reuses Claude's login.
  const classifierBlocked = opts.classifierBackend === "api" && !apiKey;
  // False once this dispatch settles, so a late verdict can't press the next task's prompt.
  let dispatchActive = true;
  const commandGate = createCommandGate({
    enabled: classifierOn,
    blocked: classifierBlocked,
    backend: opts.classifierBackend,
    model: opts.classifierModel,
    apiKey,
    cliPath: opts.classifierCli,
    task: { id: task.id, title: task.title },
    cwd: process.cwd(),
    client: { approve: () => client.approve(), reject: () => client.reject() },
    addNote: repo.addNote,
    log: (m) => console.log(m),
    isActive: () => dispatchActive,
  });

  // Question handling: when Bob asks a followup mid-task, answer it with Claude
  // (sending the reply over IPC) or escalate to a human. Reuses the classifier's
  // backend/key. Applies in any mode — any task can hit a question.
  const followupGateObj = createFollowupGate({
    enabled: opts.answerFollowups,
    blocked: classifierBlocked,
    escalateAll: opts.escalateAll,
    reviewPlans: opts.reviewPlans,
    backend: opts.classifierBackend,
    model: opts.classifierModel,
    apiKey,
    cliPath: opts.classifierCli,
    task: { id: task.id, title: task.title },
    cwd: process.cwd(),
    client: { sendMessage: (t) => client.sendMessage(t) },
    addNote: repo.addNote,
    log: (m) => console.log(m),
    isActive: () => dispatchActive,
    escalate: (question, options) => {
      console.log(`  ⤴ followup needs a human on #${task.id}: ${question.replace(/\s+/g, " ").slice(0, 80)}`);
      emit(opts, "question", { id: task.id, title: task.title, question, options });
      if (opts.notify) notify(`Bob needs an answer on #${task.id}`, question);
    },
  });

  // Register this gate so stdin answers can reach it
  activeFollowupGates.set(task.id, followupGateObj);

  let lastSay = "";
  // Last blocking ask Bob surfaced. The gate answers command asks; other types
  // (followup, mistake_limit_reached, …) we deliberately don't auto-press — we just
  // record the last one so a wedge is diagnosable instead of a silent timeout.
  let lastAsk = "";

  // Dispatch helper used by the initial run and each verify-and-continue. Marks the
  // dispatch active for its duration so the command/followup gates only press while a
  // dispatch is genuinely in flight (and a stale verdict from a prior one can't press).
  const doDispatch = async (text: string): Promise<DispatchResult> => {
    dispatchActive = true;
    try {
      return await client.dispatch({
        text,
        mode,
        config: dispatchAutoApprove(profile, opts.allowCommands),
        newTab: opts.newTab,
        timeoutMs: opts.timeoutMs,
        onEvent: (name, { say, ask, text, partial, ts }) => {
          if (say && say !== lastSay) {
            lastSay = say;
            const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
            console.log(`  · ${name}/${say}${t ? `: ${t}` : ""}`);
          }

          if (ask && !partial) lastAsk = ask;
          // .catch each gate: a press/answer that throws (e.g. an IPC write on a dropped pipe, or an
          // answerer failure) must not become an unhandled rejection that crashes the worker.
          commandGate({ ask, text, partial, ts }).catch((e) =>
            console.error(`  ⚠ command gate error on #${task.id}: ${(e as Error).message}`),
          );
          followupGateObj
            .gate({ ask, text, partial, ts })
            .catch((e) => console.error(`  ⚠ followup gate error on #${task.id}: ${(e as Error).message}`));
        },
      });
    } finally {
      dispatchActive = false;
    }
  };

  // Construct a composite verifier that combines command verification with LLM judge.
  // When --verify-judge is on:
  // - If verifyCommand is set, it runs FIRST and must pass, then judge provides additional gate
  // - If NO command is set, judge is the sole acceptance signal
  // When --verify-judge is off, the default verifier handles command execution (or blind-pass).
  //
  // The judge is diff-based, so it only applies to modes that write code. Read-only
  // and review-producing modes (ask/plan/review/devsecops) return prose/findings with
  // no diff; judging them against an empty diff would wrongly FAIL them and loop until
  // --max-continues, parking a completed task as blocked. For those modes we fall back
  // to the default verifier (runs --verify-command if set, else blind-passes).
  const judgeOn = opts.verifyJudge && judgeAppliesToMode(mode);
  if (opts.verifyJudge && !judgeOn) {
    console.log(`  [judge] skipped for {${mode}} (no code diff expected in this mode)`);
  }
  // Pre-task working-tree snapshot so the judge diffs only THIS task's changes
  // (set just before the initial dispatch below; closed over by the verifier).
  let judgeBaseline: GitBaseline | undefined;
  const compositeVerifier = judgeOn
    ? async (result: string, command: string | undefined, cwd: string): Promise<VerifyResult> => {
        // Run command verifier first if a command is set (reuse defaultVerify logic)
        if (command) {
          const cmdResult = await defaultVerify(result, command, cwd);
          if (!cmdResult.passed) {
            // Command failed: short-circuit, don't run judge
            return cmdResult;
          }
          // Command passed: run judge as additional gate
        }

        // Run the LLM judge (either as sole verifier or additional gate after command),
        // scoping the diff to this task's changes via the pre-dispatch baseline.
        const gitDiff = await captureGitDiff(cwd, 4000, judgeBaseline?.ref, judgeBaseline?.untracked);
        const ctx: JudgeContext = {
          taskPrompt: buildPrompt(task),
          completionResult: result,
          gitDiff,
        };
        const verdict = await judgeCompletion(ctx, {
          backend: opts.classifierBackend,
          model: opts.classifierModel,
          apiKey,
          cliPath: opts.classifierCli,
          timeoutMs: 30_000,
        });

        // Fail-open: a judge that couldn't reach the LLM must never block a task.
        if (verdict.error) {
          console.log(`  [judge] ${verdict.reason} — failing open (treating as passed)`);
          repo.addNote(task.id, `Judge infrastructure failure: ${verdict.reason}`, "judge");
          return { passed: true, reason: verdict.reason };
        }

        // With a command, it already passed (short-circuited above on failure), so the
        // verdict is the deciding signal; without one the judge is the sole gate.
        if (command) {
          return verdict.pass
            ? { passed: true, reason: "command and judge both passed" }
            : { passed: false, reason: `command passed but judge failed: ${verdict.reason}` };
        }
        return { passed: verdict.pass, reason: verdict.reason };
      }
    : undefined;

  // Verify-and-continue loop: on a failed verify it re-dispatches the FULL task plus
  // the failure (via doDispatch) so Bob has the context to fix it.
  const pollLoop = createPollLoop({
    enabled: opts.verifyAndContinue,
    verifyCommand: opts.verifyCommand,
    maxContinues: opts.maxContinues,
    cwd: process.cwd(),
    taskPrompt: buildPrompt(task),
    task: { id: task.id, title: task.title },
    addNote: repo.addNote,
    log: (m) => console.log(m),
    dispatch: doDispatch,
    detectPlanStop: opts.detectPlanStop,
    verify: compositeVerifier,
  });

  // Capture baseline snapshot BEFORE initial dispatch for plan-stop detection.
  // This allows detecting changes even when the tree is already dirty from prior tasks.
  // Reuses the poll loop's own snapshot fn so the baseline string-matches the snapshot
  // taken after a continue (the comparison in checkDidWork is exact-string).
  const baseline: string | undefined = opts.detectPlanStop ? await defaultCaptureSnapshot(process.cwd()) : undefined;

  // One pre-task git snapshot, reused by the judge (when on) AND by the completion
  // gate to compute execution evidence / record file artifacts. The judge needs it
  // only for code modes, but completion evidence + delete-safety want it for every
  // task (a read-only task that wrote a file must still be recorded — incident B).
  const evidenceBaseline = await captureGitBaseline(process.cwd());
  if (judgeOn) judgeBaseline = evidenceBaseline;
  // Persist a rollback checkpoint once per task (first attempt). Captured for ALL modes — a
  // read-only task that wrongly writes files should still be revertable — reusing the evidence
  // stash so we don't snapshot twice. Repo-bound + pinned (gc-safe) inside captureCheckpoint.
  if (opts.checkpoint && !repo.getCheckpoint(task.id)) {
    const cp = await captureCheckpoint(process.cwd(), task.id, evidenceBaseline.ref);
    if (cp) repo.setCheckpoint(task.id, cp);
  }

  // Initial dispatch.
  const initialRes = await doDispatch(buildPrompt(task));

  // Run the poll loop (no-op if feature is off).
  const res = await pollLoop(initialRes, baseline);

  // Format and persist review findings (review-producing modes: review + devsecops).
  // Prefer the structured submit_review_findings capture; but under headless IPC
  // dispatch Bob is tool-restricted and never calls that tool — it returns the review
  // as completion_result *text*. So when the structured capture is empty, parse the
  // result markdown into findings so the board still gets a structured note.
  // (The raw text is also stored verbatim as the task result below.)
  let findings = res.reviewFindings ?? [];
  if (findings.length === 0 && producesReviewFindings(mode) && res.result.trim()) {
    findings = parseReviewFindings(res.result);
  }
  if (findings.length > 0) {
    repo.addNote(task.id, formatReviewFindings(findings), "bob-review");
    console.log(`  📋 captured ${findings.length} review finding${findings.length === 1 ? "" : "s"}`);
  }

  // If Bob parked this task awaiting a human answer on the board (called ask_question →
  // needs_input), the dispatch ending is NOT a failure — leave it awaiting; the question's
  // own deadline + the board sweeper govern it. Don't clobber needs_input to blocked/done.
  // (worker.ts doesn't block on board questions; closing that loop is future work.)
  if (repo.getTask(task.id)?.status === "needs_input") {
    console.log(`  ❓ #${task.id} parked needs_input (awaiting a human answer on the board) — leaving it.`);
    if (res.status === "timeout" && res.taskId) client.cancel(res.taskId);
    emit(opts, "idle", { needsInput: task.id });
    return; // the loop's finally unregisters the gate
  }

  // Mark done only on a GENUINE completion: Bob fired taskCompleted, or it
  // emitted a real attempt_completion (completion_result). In some multi-step
  // tasks Bob emits completion_result then taskAborted/timeout — we still keep
  // that real result. A trailing tool payload (e.g. updateTodoList) is NOT a
  // completion: bob-ipc keeps it in res.lastText, never in res.result, so a pure
  // timeout with no completion_result now falls through to 'blocked' below.
  // The verify loop returns status "aborted" when it gave up after the continue cap:
  // verification never passed, so block for a human rather than mark a failing result
  // done — even though there's a (last, unverified) completion_result captured.
  const verifyGaveUp = opts.verifyAndContinue && res.status === "aborted";
  const captured = res.result.trim();
  if (!verifyGaveUp && (res.status === "completed" || captured)) {
    const result = captured || "(completed; no completion_result text captured)";

    // Record what changed, then let completeTask pick the terminal status. created/modified
    // count as evidence; read-only writes are tagged 'side-effect' so they don't (and aren't
    // cleanup-removable). Artifacts are recorded for every completion so delete can warn.
    const ranReadOnly = isReadOnlyMode(mode);
    const changed = await captureChangedFiles(process.cwd(), evidenceBaseline);
    for (const f of changed.created) {
      repo.recordArtifact(task.id, { kind: "file", path: f, detail: ranReadOnly ? "side-effect" : "created" });
    }
    for (const f of changed.modified) {
      repo.recordArtifact(task.id, { kind: "file", path: f, detail: ranReadOnly ? "side-effect" : "modified" });
    }
    if (changed.diffstat) {
      repo.addNote(task.id, `Changed ${changed.count} file(s) (evidence):\n${changed.diffstat}`, "worker");
    }
    // !gitAvailable → don't demote a real implementation just because we couldn't read the diff.
    const completed = repo.completeTask(task.id, { result, ranReadOnly, evidenceReliable: changed.gitAvailable });
    const finalStatus = completed?.status ?? "done";

    // Reset retry attempts on success so a future failure starts fresh.
    if (task.retry_attempts > 0) {
      repo.resetRetryAttempts(task.id);
    }
    if (res.status !== "completed") {
      repo.addNote(task.id, `Captured completion_result despite terminal '${res.status}' event.`, "worker");
    }
    const tail = res.status === "completed" ? "" : ` (Bob signalled '${res.status}' after completing)`;
    if (finalStatus === "done") {
      console.log(`  ✓ done — ${changed.count} file(s) changed, result captured (${result.length} chars)${tail}`);
    } else {
      console.log(`  ◑ ${finalStatus} — analysis captured (${result.length} chars), no verified code change${tail}`);
    }
    emit(opts, "taskDone", {
      id: task.id,
      title: task.title,
      chars: result.length,
      status: finalStatus,
      filesChanged: changed.count,
    });
    if (opts.notify) notify(`Bob finished #${task.id} (${finalStatus})`, `${task.title} — ${result}`);
  } else if (verifyGaveUp) {
    repo.updateStatus(task.id, "blocked");
    repo.addNote(
      task.id,
      `Blocked: result never passed verification after ${opts.maxContinues} continue(s).`,
      "worker",
    );
    await revertIfEnabled(opts, task.id);
    console.log(`  ✗ verification never passed — task marked blocked`);
    emit(opts, "taskFail", { id: task.id, title: task.title, status: "verify-failed" });
    if (opts.notify) notify(`Bob task #${task.id} failed verification`, task.title);
  } else {
    // No result captured: a genuine failure. Check if we should retry.
    const retryDecision = shouldRetry(res, {
      enabled: opts.retry,
      maxAttempts: opts.maxRetryAttempts,
      currentAttempts: task.retry_attempts,
      task: { id: task.id, title: task.title },
      addNote: repo.addNote,
      log: (m) => console.log(m),
    });

    if (retryDecision.shouldRetry) {
      // Increment the retry counter BEFORE re-queueing, so the next pickup sees the updated count.
      repo.incrementRetryAttempts(task.id);

      // Execute the retry: sleep for backoff, then re-queue as pending.
      await executeRetry(retryDecision, {
        enabled: opts.retry,
        maxAttempts: opts.maxRetryAttempts,
        currentAttempts: task.retry_attempts,
        task: { id: task.id, title: task.title },
        addNote: repo.addNote,
        log: (m) => console.log(m),
      });

      // Re-queue the task as pending so it gets picked up again.
      repo.updateStatus(task.id, "pending");
      console.log(`  ↻ task re-queued as pending for retry`);
      emit(opts, "taskRetry", { id: task.id, title: task.title, attempt: task.retry_attempts + 1 });
    } else {
      // No retry: park as blocked. On timeout Bob may still be churning, so tell it to stop.
      if (res.status === "timeout" && res.taskId) {
        client.cancel(res.taskId);
        console.log(`  ⓧ sent cancel to Bob task ${res.taskId}`);
      }

      repo.updateStatus(task.id, "blocked");
      const lastText = res.lastText.trim().replace(/\s+/g, " ").slice(0, 140);
      const lastNote = lastText ? ` Last activity: ${lastText}` : "";
      const askNote = lastAsk ? ` Last pending ask: '${lastAsk}'.` : "";
      const retryNote = task.retry_attempts > 0 ? ` After ${task.retry_attempts} retry attempt(s).` : "";
      repo.addNote(
        task.id,
        `Dispatch ended as '${res.status}' with no completion_result.${askNote}${lastNote}${retryNote}`,
        "worker",
      );
      await revertIfEnabled(opts, task.id);
      console.log(`  ✗ ${res.status} — task marked blocked (${retryDecision.reason})`);
      emit(opts, "taskFail", { id: task.id, title: task.title, status: res.status });
      if (opts.notify) notify(`Bob task #${task.id} ${res.status}`, task.title);
    }
  }
  // The gate is unregistered by the caller's finally (guaranteed on every exit path).
}

async function main(): Promise<void> {
  const opts = parseOpts(process.argv.slice(2));
  // A stray unhandled rejection must not crash a long-running drain — log it and keep going.
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`bob-worker: unhandled rejection (ignored): ${detail}`);
  });
  repo.getDb(); // surface schema errors up front

  // Recover tasks a previous worker run left claimed when it died mid-dispatch (crash / hard kill):
  // re-queue this assignee's in_progress tasks so they aren't stranded in_progress forever. Assumes
  // one worker per assignee (the design — a single IPC pipe dispatches serially).
  if (!opts.dryRun) {
    const reclaimed = repo.reclaimStaleInProgress(opts.assignee);
    if (reclaimed) console.log(`bob-worker: re-queued ${reclaimed} stale in_progress task(s) from a prior run.`);
  }

  const client = new BobClient(opts.pipe);
  const external = new ExternalActivity(Date.now, opts.deferStaleMs);
  client.onTaskEvent((ev) => external.handle(ev));

  console.log(`bob-worker: connecting to ${resolvePipe(opts.pipe)} …`);
  if (!opts.dryRun) {
    try {
      await client.connect();
      console.log("bob-worker: connected.");
    } catch (err) {
      console.error(`bob-worker: could not connect — ${(err as Error).message}`);
      console.error("Is Bob running, launched WITH ROO_CODE_IPC_SOCKET_PATH set? Try bob-control.mjs --list-pipes");
      emit(opts, "error", { message: (err as Error).message });
      process.exit(1);
    }
  }
  emit(opts, "connected", { pipe: resolvePipe(opts.pipe), maxRisk: opts.maxRisk });

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log("\nbob-worker: finishing current task, then stopping… (Ctrl-C again to force)");
  };
  process.on("SIGINT", stop);

  // When hosted by the extension (--emit-json), listen for human answers on stdin
  // and route them to the active task's followup gate. Also exit if parent dies.
  if (opts.emitJson) {
    process.stdin.setEncoding("utf8");
    let stdinBuf = "";
    process.stdin.on("data", (chunk: string) => {
      stdinBuf += chunk;
      let nl: number;
      while ((nl = stdinBuf.indexOf("\n")) !== -1) {
        const line = stdinBuf.slice(0, nl).trim();
        stdinBuf = stdinBuf.slice(nl + 1);
        if (line.startsWith("@@ANSWER ")) {
          handleStdinAnswer(line.slice(9), activeFollowupGates, (m) => console.log(m));
        }
      }
    });
    process.stdin.on("end", () => {
      console.log("bob-worker: parent closed stdin — exiting.");
      process.exit(0);
    });
    process.stdin.resume();
  }

  console.log(
    `bob-worker: risk gate = --max-risk ${opts.maxRisk}; defer=${opts.defer ? `on(${opts.deferIdleMs}ms)` : "off"}.`,
  );
  if (opts.commandClassifier) {
    const be = opts.classifierBackend;
    const dflt = be === "cli" ? "claude-sonnet-4-6" : "claude-haiku-4-5";
    const auth =
      be === "cli"
        ? `${opts.classifierCli ?? "claude"} CLI (reuses Claude login)`
        : process.env.ANTHROPIC_API_KEY
          ? "ANTHROPIC_API_KEY set"
          : "NO API KEY — gray-zone commands wait for a human";
    console.log(`bob-worker: command classifier = on, backend=${be} (${opts.classifierModel ?? dflt}; ${auth}).`);
    // Warn when the toggle looks on but can't actually fire (no reachable mode / no patch).
    if (!classifierReachable(opts.maxRisk)) {
      const names =
        Object.entries(MODE_PROFILES)
          .filter(([, p]) => policyHasGrayZone(p.commandPolicy))
          .map(([slug]) => slug)
          .join(", ") || "(none)";
      console.log(
        `bob-worker: ⚠ classifier will NOT engage at --max-risk ${opts.maxRisk}: ` +
          `modes with gray-zone commands [${names}] exceed the risk gate. ` +
          `Raise --max-risk to at least 'standard' (extension setting bobTasks.maxRisk) for the classifier to take effect.`,
      );
    } else if (buttonPatchPresent() === false) {
      console.log(
        "bob-worker: ⚠ Bob button patch NOT detected — approve/reject presses will be IGNORED " +
          "and classified commands will stall. Run `node tools/patch-bob-buttons.mjs` and restart Bob.",
      );
    }
  }
  if (opts.answerFollowups) {
    const noKey = opts.classifierBackend === "api" && !process.env.ANTHROPIC_API_KEY;
    const auth = noKey ? " — NO API KEY, questions escalate to you" : "";
    const escalateMode = opts.reviewPlans
      ? " — REVIEW-PLANS: plan/design questions escalate, mechanical ones auto-answer"
      : opts.escalateAll
        ? " — ESCALATE-ALL: all questions go to you for review"
        : "";
    console.log(
      `bob-worker: followup answering = on, backend=${opts.classifierBackend} (Claude answers Bob's questions, escalates when unsure${auth}${escalateMode}).`,
    );
  }
  if (opts.verifyAndContinue) {
    const cmd = opts.verifyCommand ? `command="${opts.verifyCommand}"` : "built-in heuristics";
    const judgeNote = opts.verifyJudge ? " + LLM judge" : "";
    console.log(
      `bob-worker: verify-and-continue = on (${cmd}${judgeNote}, max ${opts.maxContinues} continue${opts.maxContinues === 1 ? "" : "s"}).`,
    );
    // Warn when judge is enabled but API key is missing (fail-open behavior)
    if (opts.verifyJudge && opts.classifierBackend === "api" && !process.env.ANTHROPIC_API_KEY) {
      console.log(
        "bob-worker: ⚠ LLM judge enabled but ANTHROPIC_API_KEY not set — " +
          "judge will FAIL OPEN (pass all tasks) when it can't reach the LLM. " +
          "Set ANTHROPIC_API_KEY or use --classifier-backend cli to enable judge verdicts.",
      );
    }
  } else if (opts.verifyJudge) {
    // Warn when --verify-judge is set without --verify-and-continue (silent no-op)
    console.log(
      "bob-worker: ⚠ --verify-judge is set but --verify-and-continue is OFF — " +
        "the judge will NOT run. Enable --verify-and-continue to use the judge.",
    );
  }
  if (opts.detectPlanStop) {
    console.log(`bob-worker: plan-stop detection = on (checks git working-tree for changes, auto-continues if clean).`);
  }
  if (opts.retry) {
    console.log(
      `bob-worker: auto-retry = on (transient failures retry up to ${opts.maxRetryAttempts} total attempt${opts.maxRetryAttempts === 1 ? "" : "s"} with exponential backoff).`,
    );
  }
  let idled = false;
  let deferring = false;
  let disarmed = false;
  while (!stopping) {
    // Sweep stale board questions so a needs_input task whose asker died still times out.
    if (!opts.dryRun) repo.expireOverdueQuestions();
    // Board-level dispatch gate: while the board is disarmed, pull nothing — the curator
    // is bulk-creating/triaging and will arm when ready (anti-race, incident A). Checked
    // first so a disarm halts dispatch even mid-drain.
    if (!opts.dryRun && !repo.isBoardArmed()) {
      if (opts.once) {
        // --once must terminate; don't spin forever waiting for an arm that may never come.
        console.log("bob-worker: board disarmed — nothing to dispatch (--once); exiting.");
        break;
      }
      if (!disarmed) {
        console.log("bob-worker: board disarmed — dispatch paused (arm the board to resume).");
        emit(opts, "idle", { disarmed: true });
        disarmed = true;
      }
      await sleep(opts.pollMs);
      continue;
    }
    if (disarmed) {
      console.log("bob-worker: board armed — resuming.");
      disarmed = false;
      idled = false;
    }

    // Defer while the user is chatting with Bob, checked before any dispatch so a
    // live conversation is never aborted by our same-tab StartNewTask.
    if (opts.defer && !opts.dryRun && external.shouldDefer(opts.deferIdleMs)) {
      if (!deferring) {
        console.log("bob-worker: deferring — Bob chat active (Ctrl-C to stop).");
        emit(opts, "deferred", {});
        deferring = true;
      }
      await sleep(opts.pollMs);
      continue;
    }
    if (deferring) {
      console.log("bob-worker: chat idle — resuming.");
      emit(opts, "resumed", {});
      deferring = false;
    }

    const { task, gated, blocked } = pickEligible(opts);
    if (!task) {
      const gatedMsg =
        gated > 0
          ? ` (${gated} pending task${gated > 1 ? "s" : ""} gated above --max-risk ${opts.maxRisk} — dispatch manually)`
          : "";
      const blockedMsg =
        blocked > 0 ? ` (${blocked} pending task${blocked > 1 ? "s" : ""} blocked on dependencies)` : "";
      if (opts.once) {
        console.log(`bob-worker: no eligible pending tasks — exiting (--once)${gatedMsg}${blockedMsg}.`);
        break;
      }
      if (!idled) {
        console.log(
          `bob-worker: no eligible tasks — idle-polling every ${opts.pollMs}ms${gatedMsg}${blockedMsg}. (Ctrl-C to stop)`,
        );
        emit(opts, "idle", { gated, blocked });
        idled = true;
      }
      await sleep(opts.pollMs);
      continue;
    }
    idled = false;
    try {
      await runOne(client, task, opts);
    } catch (err) {
      console.error(`  ! error on #${task.id}: ${(err as Error).message}`);
      // Only park genuinely unfinished work — don't clobber a task that already completed
      // (done OR analysis_done) or is legitimately parked awaiting a human answer (needs_input)
      // when the error is thrown after completion/parking.
      const cur = repo.getTask(task.id)?.status;
      if (!cur || (!isCompleted(cur) && cur !== "needs_input")) {
        repo.updateStatus(task.id, "blocked");
        repo.addNote(task.id, `Worker error: ${(err as Error).message}`, "worker");
        await revertIfEnabled(opts, task.id);
        emit(opts, "taskFail", { id: task.id, status: "error", message: (err as Error).message });
      }
    } finally {
      // Guarantee the followup gate is unregistered on EVERY exit path (return / throw / needs_input),
      // so a throw mid-runOne can't leak the gate or let a stale stdin answer drive a later dispatch.
      activeFollowupGates.delete(task.id);
    }
    if (opts.once) break;
  }

  emit(opts, "stopped", {});
  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("bob-worker fatal:", err);
  process.exit(1);
});
