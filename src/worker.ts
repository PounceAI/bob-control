#!/usr/bin/env node
import "./suppress-warnings.js";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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
  isReadOnlyMode,
  type ModeProfile,
  type Risk,
} from "./modes.js";
import { createCommandGate } from "./command-gate.js";
import { createPermissionGate, type PermissionVerdict } from "./permission-gate.js";
import { createModeSwitchGate, isModeSwitchAsk } from "./mode-switch-gate.js";
import { isCommandAsk } from "./command-policy.js";
import { createFollowupGate, buildIdleAskQuestion, parseFollowup, followupDisposition } from "./followup-gate.js";
import { handleStdinAnswer } from "./worker-answer.js";
import { BobClient, resolvePipe, type DispatchResult } from "./bob-ipc.js";
import { workspaceVerdict, workspaceMismatchQuestion, type WorkspaceMismatch } from "./workspace-guard.js";
import { normalizeWorkspacePath } from "./pipe-name.js";
import { formatReviewFindings, parseReviewFindings } from "./review-findings.js";
import { createPollLoop, defaultCaptureSnapshot } from "./bob-polls.js";
import { ExternalActivity } from "./defer.js";
import { PollStatusLatch } from "./worker-status.js";
import { notify } from "./notify.js";
import { shouldRetry, executeRetry } from "./retry-policy.js";
import { buildJudgeVerifier, captureGitBaseline, captureChangedFiles, type GitBaseline } from "./judge.js";
import { captureCheckpoint, preserveWipToBranch, releaseCheckpoint } from "./checkpoint.js";
import { computeCeiling } from "./budget.js";
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
 *   node dist/worker.js --no-checkpoint     don't preserve partial work to a branch on a failed dispatch
 *   node dist/worker.js --no-idle-watchdog  disable the idle / blocked-on-ask watchdog (wall-clock only)
 *   node dist/worker.js --no-budget         disable the per-task token/turn budget backstop
 *   node dist/worker.js --deny-commands a,b  extra command prefixes/substrings to default-deny
 *   node dist/worker.js --no-command-gate   disable the deterministic permission gate (idle-watchdog backstop only)
 *   node dist/worker.js --allow-all-commands  SANDBOX ONLY: auto-run every command (Bob policy 'auto', gate off)
 *
 * Resilience guards (on by default): a deterministic permission gate (command-policy.ts) resolves
 * shell-command approval prompts non-interactively — allowlisted commands are approved, denied/unknown
 * ones are rejected, recorded as a needs_input (exact command + cwd + task), and the dispatch is ended
 * promptly (no deadlock on a human approval). An idle watchdog ends a dispatch that makes no progress
 * (or wedges on any other unanswerable ask) well before the wall clock; a token/turn budget aborts a
 * runaway loop; and on ANY terminal failure the worker preserves the dispatch's partial work to a
 * bob/task-<id> branch and restores the working tree clean (never leaves uncommitted WIP on main),
 * recording the root cause + branch in a structured note.
 *
 * Flags: --pipe <path>  --poll <ms>  --timeout <ms>  --assignee <name>  --defer-idle <ms>
 *        --verify-command <cmd>  --max-continues <n>  --retry <max-attempts>
 *        --idle-timeout <ms>  --blocked-ask-grace <ms>  --budget-headroom <pct>  --budget-cap <tokens>
 *        --max-turns <n>
 *
 * Each mode has a risk level (safe < standard < elevated); only tasks at or
 * below --max-risk are dispatched. While the user is chatting with Bob, dispatch
 * is held (a same-tab dispatch would abort the live chat) until the chat has
 * been idle for --defer-idle ms.
 *
 * With --verify-and-continue, after Bob completes a task, the worker runs an
 * acceptance check (--verify-command and/or --verify-judge; with neither, the
 * check blind-passes) and, if it fails, sends the problem back to Bob to fix —
 * looping until it passes or --max-continues is reached. This catches broken
 * builds/tests without human intervention.
 *
 * With --detect-plan-stop, the worker checks if Bob did real work (git working-tree
 * changed) after completion. If the tree is clean (plan-only, no code written), it
 * treats this as a failure and auto-continues, asking Bob to implement the plan.
 */

export interface Opts {
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
  /** Capture a pre-task checkpoint and, on a terminal failure, preserve partial work to a
   *  bob/task-<id> branch + restore main clean. Default on; --no-checkpoint disables. */
  checkpoint: boolean;
  /** Idle / blocked-on-ask watchdog window (ms). 0 = disabled (--no-idle-watchdog). */
  idleTimeoutMs: number;
  /** Shorter window once an unanswerable blocking ask is seen (ms). */
  blockedAskGraceMs: number;
  /** Per-task token budget backstop on. Default on; --no-budget disables. */
  budget: boolean;
  /** Headroom (percent) over a task's estimate before the token ceiling trips. */
  budgetHeadroomPct: number;
  /** Output-token ceiling for a task with no estimate (flat cap). */
  budgetFlatCap: number;
  /** Hard turn (api-request) cap; 0 = off. */
  maxTurns: number;
  /** Deterministic permission gate on (default); --no-command-gate disables it. */
  permissionGate: boolean;
  /** Extra command prefixes/substrings to default-deny (--deny-commands). */
  denyCommands: string[];
  /** Sandbox escape hatch: auto-run ALL commands (Bob commandPolicy 'auto'); disables the gate. */
  allowAllCommands: boolean;
}

// Watchdog / budget defaults. The blocked-ask grace is the high-value, low-false-positive guard
// (it kills a permission-prompt wedge in seconds); the pure-idle window is generous and, because a
// trip now preserves WIP to a branch, an over-eager idle trip is non-destructive.
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const DEFAULT_BLOCKED_ASK_GRACE_MS = 10_000;
const DEFAULT_BUDGET_HEADROOM_PCT = 15;
const DEFAULT_BUDGET_FLAT_CAP = 100_000;
/** Floor for the estimate-derived ceiling, so a low estimate can't abort real work early. */
const BUDGET_CEILING_FLOOR = 50_000;

export function parseOpts(argv: string[]): Opts {
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
  // Comma-separated command prefixes/substrings (extend the allowlist / denylist).
  const csv = (raw: string | undefined): string[] =>
    raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  const allowCommands = csv(val("--allow-commands"));
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
    // Checkpoint-before-death is on by default (the safety net for "never leave WIP on main");
    // --no-checkpoint opts out. --checkpoint is still accepted (a no-op) for back-compat.
    checkpoint: !has("--no-checkpoint"),
    idleTimeoutMs: has("--no-idle-watchdog") ? 0 : num("--idle-timeout", DEFAULT_IDLE_TIMEOUT_MS),
    blockedAskGraceMs: num("--blocked-ask-grace", DEFAULT_BLOCKED_ASK_GRACE_MS),
    budget: !has("--no-budget"),
    budgetHeadroomPct: num("--budget-headroom", DEFAULT_BUDGET_HEADROOM_PCT),
    budgetFlatCap: num("--budget-cap", DEFAULT_BUDGET_FLAT_CAP),
    maxTurns: num("--max-turns", 0),
    permissionGate: !has("--no-command-gate"),
    denyCommands: csv(val("--deny-commands")),
    allowAllCommands: has("--allow-all-commands"),
  };
}

/**
 * Checkpoint-before-death: on any terminal failure, preserve the task's partial work to a
 * bob/task-<id> branch and restore the working tree to its pre-task checkpoint, so a dying dispatch
 * never leaves uncommitted WIP on main. On by default; no-op without a checkpoint (not a git repo /
 * --no-checkpoint) or when HEAD moved (the work is already committed). Best-effort: never throws into
 * the worker's terminal handling. Returns the branch name when work was preserved.
 */
async function checkpointBeforeDeath(opts: Opts, taskId: number): Promise<string | undefined> {
  if (!opts.checkpoint) return undefined;
  try {
    const r = await preserveWipToBranch(process.cwd(), taskId, "worker");
    if (r.branch) console.log(`  ✓ #${taskId} partial work preserved to ${r.branch}; main restored clean`);
    else if (r.note) console.log(`  ↩ #${taskId} ${r.note}`);
    return r.branch;
  } catch (err) {
    console.log(`  ⚠ #${taskId} checkpoint-before-death errored: ${(err as Error).message}`);
    return undefined;
  }
}

/** Human-readable root cause for a failure note, keyed by dispatch status. */
const TERMINAL_CAUSE: Record<DispatchResult["status"], string> = {
  completed: "completed",
  aborted: "aborted (pipe dropped or Bob aborted the task)",
  timeout: "wall-clock timeout (no completion_result)",
  idle: "idle watchdog — no progress / wedged on an unanswerable prompt",
  budget: "token/turn budget exceeded (runaway backstop)",
};

/**
 * Highest-priority pending task whose mode's risk is at or below the gate
 * and whose dependencies are all satisfied.
 * Returns the task plus counts of tasks skipped due to risk gate or blocked dependencies.
 */
export function pickEligible(opts: Opts): { task: Task | null; gated: number; blocked: number } {
  const max = RISK_RANK[opts.maxRisk];
  const pending = repo.listTasks({ status: "pending", tag: opts.tag });
  let gated = 0;
  let blocked = 0;
  let task: Task | null = null;

  for (const t of pending) {
    // Check dependencies first (shared predicate — see db.blockingDependencies)
    const depBlock = repo.blockingDependencies(t);
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

/** Is a process alive? `process.kill(pid, 0)` sends no signal but throws ESRCH if the pid is gone
 *  (EPERM = it exists but we can't signal it = alive). Lets the lease tell a dead holder from a live one.
 *  Exported so the 2.0 in-process loop can reuse it for its reclaim peer-check (hasLivePeer). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Global registry of active followup gates, keyed by task ID. */
const activeFollowupGates = new Map<number, ReturnType<typeof createFollowupGate>>();

/** Refuse a picked task because the worker is on the wrong Bob: claim it, park it needs_input with the
 *  mismatch message (board-visible) + notify. The caller then stops draining — every task here would
 *  misroute identically, so one loud signal beats churning the whole board. */
async function parkWorkspaceMismatch(task: Task, opts: Opts, m: WorkspaceMismatch): Promise<void> {
  if (!repo.claimTask(task.id, opts.assignee)) {
    console.log(`  (task #${task.id} vanished before the workspace guard could park it)`);
    return;
  }
  const question = workspaceMismatchQuestion(m);
  const q = repo.askQuestion(task.id, question);
  if (q) {
    console.log(
      `  ✗ #${task.id} refused — wrong Bob ("${m.reported}"); parked needs_input (question ${q.question_id}).`,
    );
    emit(opts, "question", { id: task.id, title: task.title, question });
    if (opts.notify) notify("Worker hit the wrong Bob", question);
  } else {
    // Lost the claim/in_progress window — record blocked so the refusal isn't silently dropped.
    repo.updateStatus(task.id, "blocked");
    repo.addNote(task.id, `Refused (wrong Bob): ${question}`, "worker");
  }
}

async function runOne(client: BobClient, task: Task, opts: Opts, patchPresent: boolean | null): Promise<void> {
  const { mode, source, profile, pressesLand } = resolveRouting(task, patchPresent);
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

  // Read once per task and thread to the gates + judge, so both see one consistent value.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { doDispatch, getSeenAsk } = createDispatchSession(client, task, opts, { mode, profile, pressesLand }, apiKey);

  const { planStopBaseline, evidenceBaseline } = await prepareDispatch(task, opts);
  const pollLoop = buildPollLoop(task, opts, mode, doDispatch, evidenceBaseline, apiKey);

  // Initial dispatch, then the verify-and-continue loop (a no-op when the feature is off).
  const initialRes = await doDispatch(buildPrompt(task));
  const res = await pollLoop(initialRes, planStopBaseline);

  persistReviewFindings(task, mode, res);
  // The followup gate is unregistered by the caller's finally (guaranteed on every exit path).
  await finalizeDispatch(client, task, opts, mode, res, getSeenAsk(), evidenceBaseline);
}

interface Routing {
  mode: string;
  source: string;
  profile: ModeProfile;
  /** Whether our approve/reject IPC presses actually land (the Bob button patch is present). */
  pressesLand: boolean;
}

/** Route a task to a Bob mode + risk profile, and decide whether our gate presses can land. */
function resolveRouting(task: Task, patchPresent: boolean | null): Routing {
  const { mode, source } = resolveMode(task);
  const profile = profileFor(mode);
  // Our approve/reject presses (command + mode-switch gates) only land with the Bob button patch. A
  // known-absent patch (false) makes them no-ops, so an "answerable" ask actually wedges — treat it as
  // unanswerable to trip the short grace instead of the full idle window. Unknown (null) assumes present.
  const pressesLand = patchPresent !== false;
  return { mode, source, profile, pressesLand };
}

interface DispatchSession {
  /** Dispatch the given text to Bob in this task's mode, with every gate wired to its event stream. */
  doDispatch: (text: string) => Promise<DispatchResult>;
  /** Last pending root ask seen this dispatch (from any frame), for the idle-recovery needs_input. */
  getSeenAsk: () => { kind: string; text: string } | undefined;
}

/**
 * Wire up the per-task dispatch session: the four gates (command / permission / mode-switch / followup)
 * that resolve Bob's mid-task prompts non-interactively, plus the doDispatch helper that streams a
 * dispatch through them. The gates share a dispatchActive flag so a late verdict from a settled
 * dispatch can't press the next task's prompt. Registers the followup gate in activeFollowupGates so a
 * stdin answer can reach it; the caller's finally unregisters it.
 */
function createDispatchSession(
  client: BobClient,
  task: Task,
  opts: Opts,
  routing: Pick<Routing, "mode" | "profile" | "pressesLand">,
  apiKey: string | undefined,
): DispatchSession {
  const { mode, profile, pressesLand } = routing;

  // Gray-zone command approval: under allowlist or classifier policy, commands that
  // miss Bob's static allowlist surface as an `ask` instead of auto-running. Rather
  // than wait for a human, ask Claude and press approve/reject over IPC (needs the
  // Bob button patch). Fail-safe: only an explicit "approve" runs the command.
  const classifierOn = opts.commandClassifier && policyHasGrayZone(profile.commandPolicy);
  // The api backend can't run without a key; the cli backend reuses Claude's login.
  const classifierBlocked = opts.classifierBackend === "api" && !apiKey;

  // Which blocking asks a gate will actually answer. An ask outside this set is "unanswerable" for a
  // headless worker, so the idle watchdog trips its short grace instead of waiting out the wall clock.
  // Use the shared isCommandAsk so the watchdog agrees with the gates on BOTH command spellings
  // (command / command_security_warning) — one source of truth instead of re-listing them by hand.
  const commandAnswerable = classifierOn && !classifierBlocked && pressesLand;
  // Whether the worker can authorize commands a mode-switch target would run: the permission gate is
  // active (gray-zone policy) or a sandbox auto-runs everything. False for a no-command dispatch
  // (`ask`), where the mode-switch gate rejects a switch into a command mode rather than strand Bob.
  const dispatchGatesCommands =
    opts.allowAllCommands || (opts.permissionGate && policyHasGrayZone(profile.commandPolicy));
  const followupPolicy = {
    enabled: opts.answerFollowups,
    blocked: classifierBlocked,
    reviewPlans: opts.reviewPlans,
    escalateAll: opts.escalateAll,
  };
  // A followup the gate auto-answers keeps the full idle window. An escalated followup is "answerable"
  // only with a live human relay (--emit-json), who can answer over stdin this dispatch; headless has
  // none, so escalation → short grace → the idle-recovery surfaces it to the board fast.
  const isAnswerableAsk = (ask: string, text?: string): boolean => {
    if (isCommandAsk(ask) && commandAnswerable) return true;
    // The mode-switch gate (below) presses approve/reject on a switchMode ask — both outcomes resolve
    // it — so wait for it (full idle window). When the press can't land (patch absent) it's truly
    // unanswerable, so fall through to the short grace.
    if (isModeSwitchAsk(ask, text) && pressesLand) return true;
    if (ask === "followup") {
      const disp = followupDisposition(followupPolicy, parseFollowup(text ?? "")?.question ?? text ?? "");
      return disp === "answer" || (disp === "escalate" && opts.emitJson);
    }
    return false;
  };

  // Per-task token ceiling: the task's estimate (+ headroom, floored) when it carries one, else the
  // flat cap. 0 disables the token check (--no-budget). A turn cap (--max-turns) is an extra backstop.
  const tokenCeiling = opts.budget
    ? computeCeiling(task.estimated_tokens ?? undefined, {
        headroomPct: opts.budgetHeadroomPct,
        floor: BUDGET_CEILING_FLOOR,
        flatCap: opts.budgetFlatCap,
      })
    : 0;
  const turnCap = opts.budget ? opts.maxTurns : 0;

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
    client: { approve: (id) => client.approve(id), reject: (id) => client.reject(id) },
    addNote: repo.addNote,
    log: (m) => console.log(m),
    isActive: () => dispatchActive,
  });

  // Deterministic, non-interactive permission gate (command-policy.ts) — the headless analog of an
  // SDK canUseTool resolver. On by default for execute-capable modes: it approves allowlisted commands
  // and, on a denied/unknown one, rejects it, raises a structured needs_input (exact command + cwd +
  // task), and ends the dispatch — so a permission prompt can never deadlock the wall-clock. The LLM
  // classifier (--command-classifier) becomes the escalation path for unrecognised commands.
  const repoRoot = process.cwd();
  const permissionGate = createPermissionGate({
    enabled: opts.permissionGate && !opts.allowAllCommands && policyHasGrayZone(profile.commandPolicy),
    policy: { allow: opts.allowCommands, deny: opts.denyCommands, repoRoot },
    escalateToLlm: classifierOn,
    task: { id: task.id, title: task.title },
    cwd: repoRoot,
    client: {
      approve: (id) => client.approve(id),
      reject: (id) => client.reject(id),
      cancelActive: () => client.cancelActive(),
    },
    addNote: repo.addNote,
    log: (m) => console.log(m),
    isActive: () => dispatchActive,
    surface: ({ command, cwd, reason }) => {
      const short = command.replace(/\s+/g, " ").slice(0, 200);
      const question =
        `Bob needs to run a command the permission policy will not auto-approve (${reason}): ` +
        `\`${short}\` (in ${cwd}). Approve it and re-queue the task, or add it to --allow-commands.`;
      const q = repo.askQuestion(task.id, question);
      if (q) {
        console.log(`  ❓ #${task.id} command needs approval → needs_input (question ${q.question_id})`);
        emit(opts, "question", { id: task.id, title: task.title, question, command });
        if (opts.notify) notify(`Bob needs command approval on #${task.id}`, question);
      }
    },
  });

  // Mode-switch gate (mode-switch-gate.ts): resolves a mid-task switch_mode by the dispatch's risk gate
  // + command-gating reach. On for every dispatch, since a switch can occur from any mode.
  const modeSwitchGate = createModeSwitchGate({
    enabled: true,
    maxRisk: opts.maxRisk,
    canGateCommands: dispatchGatesCommands,
    task: { id: task.id, title: task.title },
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
      // The idle-recovery below owns the single board question + notify (an escalated followup trips
      // fast headless) — no notify here, else it double-toasts. The emit stays for the extension's
      // live stdin relay (--emit-json).
      console.log(`  ⤴ followup needs a human on #${task.id}: ${question.replace(/\s+/g, " ").slice(0, 80)}`);
      emit(opts, "question", { id: task.id, title: task.title, question, options });
    },
  });

  // Register this gate so stdin answers can reach it
  activeFollowupGates.set(task.id, followupGateObj);

  let lastSay = "";
  // Last pending ask (any kind) seen this dispatch, from ANY frame. bob-ipc records only FINAL asks
  // into res.pendingAsk (partials are ignored so a stream can't reset the watchdog grace), so an ask
  // that wedges before a final frame would otherwise be lost; this lets the idle-recovery surface it.
  let seenAsk: { kind: string; text: string } | undefined;

  // Dispatch helper used by the initial run and each verify-and-continue. Marks the
  // dispatch active for its duration so the command/followup gates only press while a
  // dispatch is genuinely in flight (and a stale verdict from a prior one can't press).
  const doDispatch = async (text: string): Promise<DispatchResult> => {
    dispatchActive = true;
    try {
      return await client.dispatch({
        text,
        mode,
        config: dispatchAutoApprove(
          opts.allowAllCommands ? { ...profile, commandPolicy: "auto" } : profile,
          opts.allowCommands,
        ),
        newTab: opts.newTab,
        timeoutMs: opts.timeoutMs,
        idleMs: opts.idleTimeoutMs,
        blockedAskGraceMs: opts.blockedAskGraceMs,
        isAnswerableAsk,
        tokenCeiling,
        turnCap,
        onEvent: (name, { say, ask, text, partial, ts, taskId, isRoot }) => {
          // Capture the ask for the root's idle-recovery needs_input — ROOT-only, so a routed subtask
          // command ask (the gates handle it) isn't mis-surfaced as the root's blocker. Clear only on a
          // real non-ask root message; a message-less lifecycle event isn't progress and mustn't drop it.
          if (isRoot) {
            if (ask) {
              const t = (text ?? "").trim();
              if (t) seenAsk = { kind: ask, text: t };
            } else if (say !== undefined || (text ?? "").trim() !== "") {
              seenAsk = undefined;
            }
          }

          if (say && say !== lastSay) {
            lastSay = say;
            const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
            console.log(`  · ${name}/${say}${t ? `: ${t}` : ""}`);
          }

          // Deterministic permission gate FIRST (no LLM/human): it approves allowlisted commands and
          // rejects+surfaces (needs_input) + ends the dispatch on a deny/unknown. Only an unrecognised
          // command WITH the classifier enabled is handed on to the LLM command-gate.
          // taskId (the task that raised the ask) flows to the gates so a press targets its own instance.
          let pv: PermissionVerdict = "ignored";
          try {
            pv = permissionGate({ ask, text, partial, ts, taskId });
          } catch (e) {
            console.error(`  ⚠ permission gate error on #${task.id}: ${(e as Error).message}`);
          }
          // .catch each gate: a press/answer that throws (e.g. an IPC write on a dropped pipe, or an
          // answerer failure) must not become an unhandled rejection that crashes the worker.
          if (pv === "escalate") {
            commandGate({ ask, text, partial, ts, taskId }).catch((e) =>
              console.error(`  ⚠ command gate error on #${task.id}: ${(e as Error).message}`),
            );
          }
          // Mode-switch gate: synchronous (no await); a throw here must not skip the followup gate.
          try {
            modeSwitchGate({ ask, text, partial, ts });
          } catch (e) {
            console.error(`  ⚠ mode-switch gate error on #${task.id}: ${(e as Error).message}`);
          }
          followupGateObj
            .gate({ ask, text, partial, ts })
            .catch((e) => console.error(`  ⚠ followup gate error on #${task.id}: ${(e as Error).message}`));
        },
      });
    } finally {
      dispatchActive = false;
    }
  };

  return { doDispatch, getSeenAsk: () => seenAsk };
}

/**
 * Build the verify-and-continue poll loop for this dispatch. Composes the optional LLM judge with
 * command verification (the judge is diff-based, so it applies only to code-writing modes — see
 * judgeAppliesToMode), scoping the judge's diff to this task via the pre-dispatch evidence baseline.
 * A no-op loop when --verify-and-continue is off.
 */
function buildPollLoop(
  task: Task,
  opts: Opts,
  mode: string,
  doDispatch: (text: string) => Promise<DispatchResult>,
  evidenceBaseline: GitBaseline,
  apiKey: string | undefined,
): (initial: DispatchResult, baseline?: string) => Promise<DispatchResult> {
  // The composite command-then-judge verifier (shared with the 2.0 loop), or undefined when --verify-judge
  // is off OR the judge doesn't apply to this mode — then createPollLoop falls back to command-only verify.
  const verify = opts.verifyJudge
    ? buildJudgeVerifier({
        mode,
        taskPrompt: buildPrompt(task),
        evidenceBaseline,
        judge: {
          backend: opts.classifierBackend,
          model: opts.classifierModel,
          apiKey,
          cliPath: opts.classifierCli,
          timeoutMs: 30_000,
        },
        taskId: task.id,
        addNote: repo.addNote,
        log: (m) => console.log(m),
      })
    : undefined;
  if (opts.verifyJudge && !verify) {
    console.log(`  [judge] skipped for {${mode}} (no code diff expected in this mode)`);
  }

  // Verify-and-continue loop: on a failed verify it re-dispatches the FULL task plus
  // the failure (via doDispatch) so Bob has the context to fix it.
  return createPollLoop({
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
    verify,
  });
}

/**
 * Pre-dispatch snapshots: a plan-stop baseline (working-tree state, to detect a plan-only completion),
 * the evidence baseline (reused by the judge AND the completion gate / delete-safety), and a one-time
 * rollback checkpoint. Captured once per task, before the initial dispatch.
 */
async function prepareDispatch(
  task: Task,
  opts: Opts,
): Promise<{ planStopBaseline: string | undefined; evidenceBaseline: GitBaseline }> {
  // Capture baseline snapshot BEFORE initial dispatch for plan-stop detection.
  // This allows detecting changes even when the tree is already dirty from prior tasks.
  // Reuses the poll loop's own snapshot fn so the baseline string-matches the snapshot
  // taken after a continue (the comparison in checkDidWork is exact-string).
  const planStopBaseline: string | undefined = opts.detectPlanStop
    ? await defaultCaptureSnapshot(process.cwd())
    : undefined;

  // One pre-task git snapshot, reused by the judge (when on) AND by the completion
  // gate to compute execution evidence / record file artifacts. The judge needs it
  // only for code modes, but completion evidence + delete-safety want it for every
  // task (a read-only task that wrote a file must still be recorded).
  const evidenceBaseline = await captureGitBaseline(process.cwd());
  // Persist a rollback checkpoint once per task (first attempt). Captured for ALL modes — a
  // read-only task that wrongly writes files should still be revertable — reusing the evidence
  // stash so we don't snapshot twice. Repo-bound + pinned (gc-safe) inside captureCheckpoint.
  if (opts.checkpoint && !repo.getCheckpoint(task.id)) {
    const cp = await captureCheckpoint(process.cwd(), task.id, evidenceBaseline.ref);
    if (cp) repo.setCheckpoint(task.id, cp);
  }
  return { planStopBaseline, evidenceBaseline };
}

/** Format and persist Bob's review findings (review-producing modes) as a structured board note. */
function persistReviewFindings(task: Task, mode: string, res: DispatchResult): void {
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
    console.log(`  captured ${findings.length} review finding${findings.length === 1 ? "" : "s"}`);
  }
}

/**
 * Decide and apply the task's terminal state from the dispatch result: park needs_input, surface an
 * idle/blocked-on-ask question, record a genuine completion (with evidence + artifacts), block when
 * verify-and-continue gave up, or retry / park a hard failure. Preserves partial work to a branch on
 * any terminal failure (never leaves WIP on main).
 */
async function finalizeDispatch(
  client: BobClient,
  task: Task,
  opts: Opts,
  mode: string,
  res: DispatchResult,
  seenAsk: { kind: string; text: string } | undefined,
  evidenceBaseline: GitBaseline,
): Promise<void> {
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

  // Idle / blocked-on-ask trip with no completion: the dispatch wedged on a prompt the headless
  // worker can't answer (e.g. a command-permission ask, or a followup question no gate handled).
  // bob-ipc already cancelled the Bob task on the watchdog trip; here we preserve any partial work to
  // a branch and surface the pending ask as a FIRST-CLASS board question (needs_input) so it reaches
  // the orchestrator instead of vanishing into the log. We fire on res.pendingAsk (a FINAL ask that
  // survived to trip time) OR seenAsk (any ask captured from any frame — bob-ipc records only final
  // asks, so an ask that wedged before a final frame would otherwise be lost). A pure no-progress
  // stall (neither set) falls through to the normal terminal handling (park blocked) below.
  const pendingAskKind = res.pendingAsk ?? seenAsk?.kind;
  if (res.status === "idle" && !res.result.trim() && pendingAskKind) {
    const branch = await checkpointBeforeDeath(opts, task.id);
    const rawAskText = (res.pendingAskText ?? "").trim() || seenAsk?.text || "";
    const question = buildIdleAskQuestion({ askKind: pendingAskKind, rawAskText, branch });
    const q = repo.askQuestion(task.id, question);
    if (q) {
      console.log(`  ❓ #${task.id} idle on '${pendingAskKind}' → needs_input (question ${q.question_id})`);
      emit(opts, "question", { id: task.id, title: task.title, question });
      if (opts.notify) notify(`Bob needs input on #${task.id}`, question);
    } else {
      // Couldn't park needs_input (task no longer in_progress) — record it blocked HERE with the branch
      // we already preserved, instead of falling through to a second checkpointBeforeDeath on the
      // now-consumed checkpoint (which would drop the branch pointer and write a misleading note).
      repo.updateStatus(task.id, "blocked");
      repo.addNote(task.id, `Idle/blocked-on-ask; could not park needs_input. ${question}`, "worker");
      emit(opts, "taskFail", { id: task.id, title: task.title, status: "idle", branch });
    }
    return; // either branch handled it; the loop's finally unregisters the gate
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
    // Consume the pre-task checkpoint on success so a default-on checkpoint doesn't pin one gc-immune
    // commit per completed task forever — the preserve-to-branch net only needs it on a failure.
    await releaseCheckpoint(task.id, process.cwd());
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
    const branch = await checkpointBeforeDeath(opts, task.id);
    repo.updateStatus(task.id, "blocked");
    const branchNote = branch ? ` Partial work preserved to branch ${branch}.` : "";
    repo.addNote(
      task.id,
      `Blocked: result never passed verification after ${opts.maxContinues} continue(s).${branchNote}`,
      "worker",
    );
    console.log(`  ✗ verification never passed — task marked blocked`);
    emit(opts, "taskFail", { id: task.id, title: task.title, status: "verify-failed", branch });
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
      // No retry: park as blocked. A wall-clock 'timeout' may leave Bob still running, so cancel it
      // (idle/budget were already cancelled at the bob-ipc trip; an 'aborted' pipe has nothing to
      // cancel). Then preserve any partial work to a branch (never leave WIP on main) and write a
      // STRUCTURED failure note: root cause, last activity, pending ask, usage, branch.
      if (res.status === "timeout" && res.taskId) {
        client.cancel(res.taskId);
        console.log(`  ⓧ sent cancel to Bob task ${res.taskId}`);
      }

      const branch = await checkpointBeforeDeath(opts, task.id);
      repo.updateStatus(task.id, "blocked");
      const lastText = res.lastText.trim().replace(/\s+/g, " ").slice(0, 140);
      const lastNote = lastText ? ` Last activity: ${lastText}.` : "";
      const askNote = res.pendingAsk ? ` Last pending ask: '${res.pendingAsk}'.` : "";
      const usageNote = res.tokensUsed ? ` (~${res.tokensUsed} output tokens, ${res.turns ?? 0} turns).` : "";
      const branchNote = branch ? ` Partial work preserved to branch ${branch}.` : "";
      const retryNote = task.retry_attempts > 0 ? ` After ${task.retry_attempts} retry attempt(s).` : "";
      repo.addNote(
        task.id,
        `Dispatch ended: ${TERMINAL_CAUSE[res.status]}.${askNote}${usageNote}${lastNote}${branchNote}${retryNote}`,
        "worker",
      );
      console.log(`  ✗ ${res.status} — task marked blocked (${retryDecision.reason})`);
      emit(opts, "taskFail", { id: task.id, title: task.title, status: res.status, branch });
      if (opts.notify) notify(`Bob task #${task.id} ${res.status}`, task.title);
    }
  }
}

export async function main(): Promise<void> {
  const opts = parseOpts(process.argv.slice(2));
  // A stray unhandled rejection must not crash a long-running drain — log it and keep going.
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`bob-worker: unhandled rejection (ignored): ${detail}`);
  });
  repo.getDb(); // surface schema errors up front

  // Worktree lease + heartbeat (T7): at most one live worker per checkout. Keyed on the normalized cwd,
  // so it holds whether the board is per-project or worktree-shared. claimWorktreeLease checks-and-claims
  // atomically (one transaction), so two workers starting together can't both observe "no holder" and
  // both proceed. The claim doubles as the first liveness heartbeat board_status reads.
  const workerId = randomUUID();
  const worktreeKey = normalizeWorkspacePath(process.cwd());
  const beatMeta = { assignee: opts.assignee, pid: process.pid, worktree: worktreeKey, tag: opts.tag };
  if (!opts.dryRun) {
    let res = repo.claimWorktreeLease(workerId, beatMeta);
    // A holder whose pid is provably dead (hard kill) is reclaimable; an unknown (null) pid counts as
    // alive (conservative — never stomp a possibly-live worker). Reclaim a dead one, then retry the claim.
    if (!res.claimed && !repo.holderIsLive(res.holder.pid, pidAlive)) {
      console.log(`bob-worker: reclaiming a dead worker's lease (pid ${res.holder.pid ?? "?"}) on ${process.cwd()}.`);
      repo.clearWorkerHeartbeat(res.holder.worker_id);
      res = repo.claimWorktreeLease(workerId, beatMeta);
    }
    if (!res.claimed) {
      const h = res.holder;
      const who = `another worker (pid ${h.pid ?? "?"}, last beat ${h.last_beat_seconds_ago}s ago) owns this checkout's lease:\n  ${process.cwd()}`;
      // For --once this is not an error — that worker drains the board and will run the queued task — so
      // exit 0; a duplicate CONTINUOUS worker is a real misconfig that corrupts dispatch, so exit 1.
      if (opts.once) {
        console.log(`bob-worker: ${who}\nNothing to do — that worker is already draining this board (--once).`);
        process.exit(0);
      }
      console.error(
        `bob-worker: ✗ ${who}\nRefusing — two workers on one checkout corrupt each other's dispatch. Stop that ` +
          `worker, or (after a hard kill) wait ${Math.ceil(repo.WORKER_HEARTBEAT_WINDOW_MS / 1000)}s for the lease to lapse.`,
      );
      emit(opts, "error", { message: `worktree lease held by pid ${h.pid ?? "?"} on ${process.cwd()}` });
      process.exit(1);
    }
    // Lease held (the claim recorded the first beat). startHeartbeat refreshes on a timer; its stop() is
    // wired to process exit here (vs the 2.0 loop's finally). A hard kill is covered by the window + pid reclaim.
    const stopHeartbeat = repo.startHeartbeat(workerId, beatMeta);
    process.on("exit", () => {
      try {
        stopHeartbeat();
      } catch {
        /* best-effort on the way out */
      }
    });
  }

  // Recover tasks a previous worker run left claimed when it died mid-dispatch (crash / hard kill):
  // re-queue this assignee's in_progress tasks so they aren't stranded forever. Scope it to this
  // worker's --tag so that, on a shared board where several worktree workers run as the same default
  // assignee, one worker's startup can't re-queue another worktree's in-flight task (no --tag → all,
  // the single-worker default).
  if (!opts.dryRun) {
    const reclaimed = repo.reclaimStaleInProgress(opts.assignee, opts.tag);
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

  // Layer-2 workspace handshake: ask the Bob we just connected to which folder it has open and confirm
  // it's ours, so a misconfigured pipe pairing surfaces as a refusal instead of silently editing the
  // wrong tree. Verdict applied per dispatch below (parking needs_input). Bob's reported folder can't
  // change without a window reload, which drops the pipe — so a one-shot check at connect is enough.
  let workspaceMismatch: WorkspaceMismatch | null = null;
  if (!opts.dryRun) {
    const reported = await client.queryWorkspace();
    workspaceMismatch = workspaceVerdict(reported, process.cwd());
    if (!reported) {
      console.log(
        "bob-worker: ⚠ workspace handshake unavailable (Bob lacks the GetWorkspace patch, or no reply) — " +
          "layer-2 guard inactive; relying on the pipe pairing (layer 1). Run `node tools/patch-bob-buttons.mjs` + restart Bob to enable it.",
      );
    } else if (workspaceMismatch) {
      console.error(
        `bob-worker: ✗ WRONG BOB — connected to a Bob open on "${reported}", but this worker is for ` +
          `"${process.cwd()}". Tasks will be parked needs_input, NOT dispatched. Fix the pipe pairing and restart.`,
      );
      emit(opts, "error", { message: `workspace mismatch: bob=${reported} worker=${process.cwd()}` });
    } else {
      console.log(`bob-worker: ✓ workspace handshake OK — Bob is open on ${reported}.`);
    }
  }

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
  // Probe the button patch once and thread it into runOne (both the always-on mode-switch gate and the
  // command gate press over IPC, which only lands with the patch). null = couldn't probe; assume present.
  const patchPresent = buttonPatchPresent();
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
    // Warn when the classifier toggle looks on but can't actually fire (no mode within the risk gate).
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
    }
  }
  // Hoisted out of the classifier block: the mode-switch gate presses on every dispatch, so a missing
  // patch stalls mode switches even with the classifier off (when the old nested warning stayed silent).
  if (patchPresent === false) {
    console.log(
      "bob-worker: ⚠ Bob button patch NOT detected — approve/reject presses will be IGNORED, so " +
        "mode switches (and any classified commands) will stall. Run `node tools/patch-bob-buttons.mjs` and restart Bob.",
    );
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
    const cmd = opts.verifyCommand ? `command="${opts.verifyCommand}"` : "no verify command — blind-pass";
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
  console.log(
    `bob-worker: resilience — idle watchdog ${
      opts.idleTimeoutMs > 0 ? `${opts.idleTimeoutMs}ms (blocked-ask grace ${opts.blockedAskGraceMs}ms)` : "off"
    }; token budget ${
      opts.budget
        ? `on (headroom ${opts.budgetHeadroomPct}%, flat cap ${opts.budgetFlatCap}${opts.maxTurns ? `, max-turns ${opts.maxTurns}` : ""})`
        : "off"
    }; checkpoint-before-death ${opts.checkpoint ? "on (preserve WIP to bob/task-<id>)" : "off"}.`,
  );
  console.log(
    `bob-worker: command permissions — ${
      opts.allowAllCommands
        ? "ALLOW-ALL (sandbox bypass: every command auto-runs, gate off)"
        : opts.permissionGate
          ? `deterministic gate ON (allowlist auto-runs; denied/unknown → needs_input + end${opts.commandClassifier ? "; unknown escalates to the classifier" : "; default-deny"})`
          : "gate OFF (commands fall back to the idle-watchdog backstop)"
    }.`,
  );
  // One latch for the between-dispatch status (announce once per entry, re-announce on return). See
  // worker-status.ts for why three separate booleans drifted and stuck the status on "running".
  const pollStatus = new PollStatusLatch();
  while (!stopping) {
    // Sweep stale board questions so a needs_input task whose asker died still times out.
    if (!opts.dryRun) repo.expireOverdueQuestions();
    // Board-level dispatch gate: while the board is disarmed, pull nothing — the curator
    // is bulk-creating/triaging and will arm when ready (anti-race). Checked
    // first so a disarm halts dispatch even mid-drain.
    if (!opts.dryRun && !repo.isBoardArmed()) {
      if (opts.once) {
        // --once must terminate; don't spin forever waiting for an arm that may never come.
        console.log("bob-worker: board disarmed — nothing to dispatch (--once); exiting.");
        break;
      }
      if (pollStatus.enter("disarmed")) {
        console.log("bob-worker: board disarmed — dispatch paused (arm the board to resume).");
        emit(opts, "idle", { disarmed: true });
      }
      await sleep(opts.pollMs);
      continue;
    }
    if (pollStatus.is("disarmed")) {
      // Board re-armed; the next status (defer/idle/active) re-announces below since it differs.
      console.log("bob-worker: board armed — resuming.");
    }

    // Defer while the user is chatting with Bob, checked before any dispatch so a
    // live conversation is never aborted by our same-tab StartNewTask.
    if (opts.defer && !opts.dryRun && external.shouldDefer(opts.deferIdleMs)) {
      if (pollStatus.enter("deferred")) {
        console.log("bob-worker: deferring — Bob chat active (Ctrl-C to stop).");
        emit(opts, "deferred", {});
      }
      await sleep(opts.pollMs);
      continue;
    }
    if (pollStatus.is("deferred")) {
      console.log("bob-worker: chat idle — resuming.");
      emit(opts, "resumed", {});
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
      // enter("idle") returns true after any other status too, so idle is re-announced once a
      // dispatch or defer ends (see worker-status.ts).
      if (pollStatus.enter("idle")) {
        console.log(
          `bob-worker: no eligible tasks — idle-polling every ${opts.pollMs}ms${gatedMsg}${blockedMsg}. (Ctrl-C to stop)`,
        );
        emit(opts, "idle", { gated, blocked });
      }
      await sleep(opts.pollMs);
      continue;
    }
    // Wrong-Bob guard (layer 2): refuse to dispatch into a Bob open on a different workspace. Park this
    // task needs_input (board-visible) and halt — every queued task would misroute the same way, so one
    // loud signal beats churning the whole board. Exit non-zero: a fatal misroute is a failure, not a
    // clean stop, so a supervisor/extension treats it as one (startup error + parked task explain it).
    if (workspaceMismatch) {
      await parkWorkspaceMismatch(task, opts, workspaceMismatch);
      client.close();
      process.exit(1);
    }
    pollStatus.enter("active");
    try {
      await runOne(client, task, opts, patchPresent);
    } catch (err) {
      console.error(`  ! error on #${task.id}: ${(err as Error).message}`);
      // Only park genuinely unfinished work — don't clobber a task that already completed
      // (done OR analysis_done) or is legitimately parked awaiting a human answer (needs_input)
      // when the error is thrown after completion/parking.
      const cur = repo.getTask(task.id)?.status;
      if (!cur || (!isCompleted(cur) && cur !== "needs_input")) {
        const branch = await checkpointBeforeDeath(opts, task.id);
        repo.updateStatus(task.id, "blocked");
        const branchNote = branch ? ` Partial work preserved to branch ${branch}.` : "";
        repo.addNote(task.id, `Worker error: ${(err as Error).message}.${branchNote}`, "worker");
        emit(opts, "taskFail", { id: task.id, status: "error", message: (err as Error).message, branch });
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

// Auto-run only as a CLI. Importing worker.ts — to reuse parseOpts / pickEligible / main from the 2.0
// in-process driver (or a test) — must have no side effects. Matches cli.ts's is-main guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("bob-worker fatal:", err);
    process.exit(1);
  });
}
