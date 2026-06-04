// LLM-based task completion judge. When a task has no deterministic verify command,
// the judge asks Claude whether Bob's work actually satisfies the task criteria.
// Designed to be testable: the LLM call is injected, and the verdict parsing is pure.
import { callModel, type LlmDeps } from "./llm.js";
import { resolve as resolvePath } from "node:path";
import { gitOut, splitLines, isInsideWorkTree, listUntracked } from "./git.js";

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
    "ACTUAL CHANGES (git diff HEAD):",
    ctx.gitDiff || "(no changes detected)",
  ].join("\n");
}

/**
 * Scan `text` for balanced top-level `{...}` substrings, returning each as a string.
 * String-aware (braces inside JSON string literals are ignored) and nesting-aware,
 * so a verdict whose reason contains a brace — e.g. {"pass":true,"reason":"see {x}"}
 * — or a nested object is still extracted whole, unlike a `\{[^{}]*\}` regex which
 * stops at the first inner brace. Pure; never throws.
 */
function extractJsonObjects(text: string): string[] {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objs;
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
  return { ref, untracked };
}

/**
 * Capture a bounded diff of THIS task's changes for the judge's ground truth.
 * Diffs the working tree against `baselineRef` (a real ref/SHA, default HEAD, so
 * pre-existing tracked changes are excluded), and temporarily marks task-created
 * untracked files as intent-to-add so new files appear in the diff. Files in
 * `priorUntracked` are skipped (they predate the task), and the intent-to-add marks
 * are reset in a finally block so the user's index is left exactly as it was found.
 */
export async function captureGitDiff(
  cwd: string,
  maxChars = 4000,
  baselineRef = "HEAD",
  priorUntracked: string[] = [],
): Promise<string> {
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

// Made with Bob
