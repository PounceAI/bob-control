// LLM-based task completion judge. When a task has no deterministic verify command,
// the judge asks Claude whether Bob's work actually satisfies the task criteria.
// Designed to be testable: the LLM call is injected, and the verdict parsing is pure.
import { callModel, type LlmDeps } from "./llm.js";
import { resolve as resolvePath } from "node:path";
import { gitOut, runGit, splitLines, isInsideWorkTree, listUntracked, snapshotWorktreeTreeBounded } from "./git.js";
import { extractJsonObjects } from "./json-extract.js";
import { defaultVerify, type VerifyResult } from "./bob-polls.js";
import { judgeAppliesToMode } from "./modes.js";

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
  /** True when the verdict is a fail-open default because the LLM couldn't be reached. */
  error?: boolean;
}

export interface JudgeContext {
  /** The original task prompt/criteria Bob was given. */
  taskPrompt: string;
  /** Bob's completion_result text. */
  completionResult: string;
  /** Git diff showing actual changes (truncated for token budget). */
  gitDiff: string;
}

/** A pre-task working-tree snapshot used to scope the judge's diff to this task. */
export interface GitBaseline {
  /** A real git ref/SHA capturing the tracked tree state before the task ran (stash-create). */
  ref: string;
  /** Untracked files that already existed before the task (so new files can be told apart). */
  untracked: string[];
  /** Untracked-aware tree sha of the pre-task worktree, so the diff can see content edits to files
   *  that stay untracked (plain `git diff` omits untracked content). Undefined when not a git tree. */
  tree?: string;
}

/** Backend + model + transport overrides (see llm.ts). */
export type JudgeDeps = LlmDeps;

const SYSTEM = [
  "You are a strict acceptance reviewer for an AI coding agent's completed work.",
  "Decide whether the agent GENUINELY completed the task based on:",
  "- The original task criteria",
  "- The agent's completion statement",
  "- The actual code changes (git diff)",
  "",
  "Rules:",
  "- PASS only if the task is demonstrably complete and the changes match the requirements.",
  "- FAIL if the work is incomplete, the changes don't match the task, or the agent only presented a plan without implementing it.",
  "- Be strict: partial work, missing requirements, or 'I will do X' statements are FAIL.",
  "",
  'Respond with ONLY compact JSON, no prose: {"pass":true|false,"reason":"<=20 words"}.',
].join("\n");

function userContent(ctx: JudgeContext): string {
  return [
    "TASK CRITERIA:",
    ctx.taskPrompt,
    "",
    "AGENT'S COMPLETION STATEMENT:",
    ctx.completionResult,
    "",
    "ACTUAL CHANGES (working-tree diff since the task started):",
    ctx.gitDiff || "(no changes detected)",
  ].join("\n");
}

/**
 * Parse the model's reply into a JudgeVerdict. Pure and total: never throws,
 * defaults to a safe FAIL when the output isn't a clear decision.
 * Accepts both JSON {"pass":boolean,"reason":"..."} and bare PASS/FAIL tokens.
 */
export function parseVerdict(text: string): JudgeVerdict {
  // Try JSON first (preferred format). Extract all balanced {...} objects and try
  // to parse each one, taking the first valid one with a pass field.
  for (const candidate of extractJsonObjects(text)) {
    try {
      const obj = JSON.parse(candidate);
      // Accept boolean pass, or coerce string 'true'/'false' and numeric 0/1
      let pass: boolean | undefined;
      if (typeof obj?.pass === "boolean") {
        pass = obj.pass;
      } else if (typeof obj?.pass === "string") {
        const lower = obj.pass.toLowerCase();
        if (lower === "true") pass = true;
        else if (lower === "false") pass = false;
      } else if (typeof obj?.pass === "number") {
        pass = obj.pass !== 0;
      }
      if (pass !== undefined) {
        const reason = typeof obj?.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "(no reason)";
        return { pass, reason };
      }
    } catch {
      // This match wasn't valid JSON, try the next one
      continue;
    }
  }

  // Fallback: look for bare PASS or FAIL tokens with word boundaries to avoid
  // false matches in negations ('will not pass', 'no failures', 'bypass').
  // Check for negations first: "not pass", "no fail", etc.
  // FAIL takes precedence over PASS.
  const NEG = String.raw`(?:not|no|won't|will\s+not|does\s*n['’]?t|can\s*not|can['’]?t)`;
  const hasNegatedPass = new RegExp(String.raw`\b${NEG}\s+pass\b`, "i").test(text);
  const hasNegatedFail = new RegExp(String.raw`\b${NEG}\s+fail\b`, "i").test(text);

  const failMatch = /\bFAIL\b/i.test(text);
  const passMatch = /\bPASS\b/i.test(text);

  // If we have a negated pass ("will not pass"), treat as fail
  if (hasNegatedPass) {
    return { pass: false, reason: "judge verdict: FAIL" };
  }
  // If we have a negated fail ("no failures"), don't treat as fail
  if (failMatch && !hasNegatedFail) {
    return { pass: false, reason: "judge verdict: FAIL" };
  }
  if (passMatch) {
    return { pass: true, reason: "judge verdict: PASS" };
  }

  // Unparseable: fail safe (treat as incomplete)
  return { pass: false, reason: "unparseable judge output" };
}

/**
 * Snapshot the pre-task working tree so the judge can later diff against it and see
 * ONLY this task's changes — not pre-existing dirt from earlier tasks in a drain.
 * `git stash create` writes the current tracked tree to a dangling commit and returns
 * its SHA WITHOUT touching the index, working tree, or stash list; an empty result
 * (clean tree) falls back to HEAD. Also records the already-existing untracked files
 * so new-file deliverables can be told apart from pre-existing artifacts.
 */
export async function captureGitBaseline(cwd: string): Promise<GitBaseline> {
  const ref = (await gitOut(["stash", "create"], cwd)).trim() || "HEAD";
  const untracked = await listUntracked(cwd);
  // Untracked-aware tree so captureGitDiff diffs untracked CONTENT, not just presence; bounded
  // against a wedged git.
  const tree = (await snapshotWorktreeTreeBounded(cwd)) ?? undefined;
  return { ref, untracked, tree };
}

/**
 * Bounded diff of THIS task's changes — the judge's ground truth.
 *
 * With `baselineTree`: tree-vs-fresh-snapshot diff. Both stage untracked files, so edits that stay
 * untracked surface and pre-existing dirt cancels — which plain `git diff` can't do. Blind spot:
 * `add -A` honors `.gitignore`, so an ignored-path deliverable is invisible.
 * Without one (non-git / git too old): diff against `baselineRef`, intent-to-adding task-created
 * untracked files (not in `priorUntracked`) so they appear; marks reset in a finally.
 */
export async function captureGitDiff(
  cwd: string,
  maxChars = 4000,
  baselineRef = "HEAD",
  priorUntracked: string[] = [],
  baselineTree?: string,
): Promise<string> {
  if (baselineTree) {
    const currTree = await snapshotWorktreeTreeBounded(cwd);
    if (currTree) {
      // Gate on `ok`: a failed diff (unresolvable baselineTree) has empty stdout that gitOut can't
      // tell from a clean tree. Truncation counts as ok (deliberate stop, valid partial diff).
      const res = await runGit(["diff", baselineTree, currTree], cwd, maxChars);
      if (res.ok) return res.stdout || "(no changes detected)";
    }
    // Tree path failed (snapshot or diff) — degrade to the ref diff, and leave a trail: the two paths
    // differ exactly on untracked-content edits, so a silent fallback hides why the judge saw less.
    console.error(`[bob-control] captureGitDiff: tree path unavailable in ${cwd}, using ref-based diff`);
  }
  const prior = new Set(priorUntracked);
  const newFiles = (await listUntracked(cwd)).filter((f) => !prior.has(f));
  if (newFiles.length) await gitOut(["add", "--intent-to-add", "--", ...newFiles], cwd);
  try {
    const diff = await gitOut(["diff", baselineRef], cwd, maxChars);
    return diff || "(no changes detected)";
  } finally {
    if (newFiles.length) await gitOut(["reset", "--quiet", "--", ...newFiles], cwd);
  }
}

export interface ChangedFiles {
  /** Absolute paths of all files this task created or modified (created ∪ modified). */
  files: string[];
  /** Absolute paths of files the task CREATED (new untracked) — safe to remove on cleanup. */
  created: string[];
  /** Absolute paths of pre-existing tracked files the task MODIFIED — NOT safe to delete. */
  modified: string[];
  /** Human-readable `git diff --stat` summary (tracked changes). */
  diffstat: string;
  /** Total distinct files changed (created + modified). */
  count: number;
  /** False when cwd is not a git work tree — so callers can avoid mismarking work as unbuilt. */
  gitAvailable: boolean;
}

/**
 * Files this task changed vs a pre-task baseline, split CREATED (new untracked, minus prior)
 * vs MODIFIED (tracked changes vs `ref`), as absolute paths. gitAvailable:false when cwd isn't
 * a git work tree, so callers don't read "no changes" as "did no work".
 */
export async function captureChangedFiles(cwd: string, baseline?: GitBaseline): Promise<ChangedFiles> {
  const empty: ChangedFiles = { files: [], created: [], modified: [], diffstat: "", count: 0, gitAvailable: false };
  if (!(await isInsideWorkTree(cwd))) return empty;

  const ref = baseline?.ref ?? "HEAD";
  const prior = new Set(baseline?.untracked ?? []);
  const [trackedRaw, untracked, diffstatRaw] = await Promise.all([
    gitOut(["diff", "--name-only", ref], cwd),
    listUntracked(cwd),
    gitOut(["diff", "--stat", ref], cwd, 2000),
  ]);
  const modified = splitLines(trackedRaw).map((f) => resolvePath(cwd, f));
  const created = untracked.filter((f) => !prior.has(f)).map((f) => resolvePath(cwd, f));
  const files = Array.from(new Set([...created, ...modified]));
  return { files, created, modified, diffstat: diffstatRaw.trim(), count: files.length, gitAvailable: true };
}

/**
 * Judge a task completion via the configured LLM backend.
 * Fails OPEN on any LLM error or timeout (returns pass:true with error:true):
 * judge-infrastructure failure must never block an otherwise-good task. The
 * caller logs the fail-open and records a note. A genuine model verdict of
 * "incomplete" still fails (pass:false) via parseVerdict.
 */
export async function judgeCompletion(ctx: JudgeContext, deps: JudgeDeps): Promise<JudgeVerdict> {
  const res = await callModel(SYSTEM, userContent(ctx), deps, 150);
  return res.ok
    ? parseVerdict(res.text)
    : { pass: true, error: true, reason: `judge unavailable (fail-open): ${res.reason}` };
}

export interface JudgeVerifierDeps {
  /** Routed mode — the judge is diff-based, so it applies only to code-writing modes (else undefined). */
  mode: string;
  /** The original task criteria the judge checks the work against. */
  taskPrompt: string;
  /** Pre-task baseline scoping the diff to THIS task; falls back to HEAD / no-prior-untracked when absent. */
  evidenceBaseline?: GitBaseline;
  /** LLM backend config (backend/model/apiKey/cliPath/timeoutMs; fetchImpl/spawnImpl injectable in tests). */
  judge: JudgeDeps;
  taskId: number;
  addNote: (taskId: number, note: string, author?: string) => void;
  log: (msg: string) => void;
}

/**
 * Build the composite acceptance verifier (command-then-judge) for the verify-and-continue poll loop, or
 * undefined when the LLM judge doesn't apply to this mode — read-only/review modes have no diff, so judging
 * them would wrongly FAIL; the caller then falls back to command-only `defaultVerify`. Shared by the 1.x
 * worker and the 2.0 in-process loop so both behave identically:
 *   - a verify command (if set) runs FIRST and short-circuits on failure; else the judge is the sole gate;
 *   - the judge sees ONLY this task's diff (scoped to evidenceBaseline);
 *   - fail-open: a judge that can't reach the LLM never blocks (passes + records a note).
 */
export function buildJudgeVerifier(
  deps: JudgeVerifierDeps,
): ((result: string, command: string | undefined, cwd: string) => Promise<VerifyResult>) | undefined {
  if (!judgeAppliesToMode(deps.mode)) return undefined;
  const ref = deps.evidenceBaseline?.ref ?? "HEAD";
  const priorUntracked = deps.evidenceBaseline?.untracked ?? [];
  const baselineTree = deps.evidenceBaseline?.tree;
  return async (result, command, cwd): Promise<VerifyResult> => {
    if (command) {
      const cmd = await defaultVerify(result, command, cwd);
      if (!cmd.passed) return cmd; // command failed → short-circuit, skip the judge
    }
    const gitDiff = await captureGitDiff(cwd, 4000, ref, priorUntracked, baselineTree);
    const verdict = await judgeCompletion(
      { taskPrompt: deps.taskPrompt, completionResult: result, gitDiff },
      deps.judge,
    );
    if (verdict.error) {
      // Fail-open: judge-infrastructure failure must never block an otherwise-good task.
      deps.log(`  [judge] ${verdict.reason} — failing open (treating as passed)`);
      deps.addNote(deps.taskId, `Judge infrastructure failure: ${verdict.reason}`, "judge");
      return { passed: true, reason: verdict.reason };
    }
    // With a command it already passed (short-circuited on failure), so the verdict decides; without one
    // the judge is the sole gate.
    if (command) {
      return verdict.pass
        ? { passed: true, reason: "command and judge both passed" }
        : { passed: false, reason: `command passed but judge failed: ${verdict.reason}` };
    }
    return { passed: verdict.pass, reason: verdict.reason };
  };
}
