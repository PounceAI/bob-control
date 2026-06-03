import type { Task } from "./types.js";

// Bob's built-in modes. `mode` is stored as a free string so custom Roo
// .roomodes slugs work too; setting configuration.mode on dispatch switches Bob.
export const BUILT_IN_MODES = ["code", "advanced", "ask", "orchestrator", "plan", "review", "refactor", "devsecops"] as const;
export type BuiltInMode = (typeof BUILT_IN_MODES)[number];

export const DEFAULT_MODE: BuiltInMode = "code";

export function isBuiltInMode(slug: string): slug is BuiltInMode {
  return (BUILT_IN_MODES as readonly string[]).includes(slug);
}

// Keyword router for tasks with no explicit mode. Order matters:
// advanced > orchestrator > ask, then code as fallback.
const RULES: { mode: BuiltInMode; re: RegExp }[] = [
  // Needs MCP/Browser tools, which plain code mode lacks; must win.
  // `https?` so an https URL matches too (bare `http` before \b misses "https").
  { mode: "advanced", re: /\b(browser|web ?page|website|url|scrape|crawl|navigate|screenshot|mcp tool|fetch the|https?)\b/i },
  // `orchestrat\w*` so the stem matches orchestrate / orchestrator / orchestration
  // (a bare `orchestrat` before the trailing \b never matches the full word).
  { mode: "orchestrator", re: /\b(orchestrat\w*|coordinate|multi[- ]step|break (it |this )?down|sub-?tasks?|workflow|epic|several steps)\b/i },
  { mode: "ask", re: /\b(explain|describe|document|docs|summari[sz]e|analy[sz]e|research|investigate|what is|what are|how does|how do|why does|why is|question|clarify|review (the )?(concept|approach|design)|understand)\b/i },
];

// Implementation verbs. A task carrying these wants code WRITTEN, so it must NOT be
// silently routed to read-only `ask` just because it also says "analyze"/"review"
// (incident C: a PHI-MINIMIZATION task auto-routed to ask, then marked done with no
// code). When both signals are present, implementation wins — ask is suppressed and the
// task falls through to `code`.
const IMPL_VERBS =
  /\b(implement|fix|patch|add|create|build|migrat\w*|refactor|rewrite|remove|delete|rename|wire up|integrate|enforce|minimi[sz]e|sanitiz\w*|redact|encrypt|deduplicat\w*|harden|update the code|change the code)\b/i;

/** True when the task text asks for code to be written (see IMPL_VERBS). */
export function looksLikeImplementation(text: string): boolean {
  return IMPL_VERBS.test(text);
}

// Per-mode safety profile. `risk` gates which tasks the worker dispatches
// (see worker --max-risk). `autoApprove` is the per-dispatch toggle set so e.g.
// an ask task runs read-only even if global state.vscdb has everything on.
// Field names match Bob's globalState keys (see set-bob-autoapprove.mjs).
export type Risk = "safe" | "standard" | "elevated";
export const RISK_RANK: Record<Risk, number> = { safe: 0, standard: 1, elevated: 2 };

// How a mode gates Bob's command execution. The worker turns this into the
// allowedCommands Bob sees on dispatch; the bobide extension reads it to decide
// whether to arm the Claude classifier on gray-zone (unmatched) commands.
//  - none:       no command execution at all (execute toggle stays off)
//  - allowlist:  SAFE_COMMANDS auto-run; anything else -> Bob's manual prompt
//  - classifier: same allowlist fast-path, but the extension asks Claude to
//                approve/deny commands that fall through instead of a human
//  - auto:       "*" — auto-run anything (trust/sandbox only)
export type CommandPolicy = "none" | "allowlist" | "auto" | "classifier";

export interface ModeProfile {
  risk: Risk;
  commandPolicy: CommandPolicy;
  autoApprove: {
    // Master switch: Bob ignores every alwaysAllow* flag below unless this is true.
    autoApprovalEnabled: boolean;
    alwaysAllowReadOnly: boolean;
    alwaysAllowWrite: boolean;
    alwaysAllowExecute: boolean;
    alwaysAllowMcp: boolean;
    alwaysAllowBrowser: boolean;
  };
}

// Safe command prefixes the worker lets Bob auto-run unattended (Bob's QMo does a
// case-insensitive startsWith match). Anything NOT matched here — rm, del, format,
// shutdown, or simply an unrecognized command — gets neither an allow nor a deny
// match, so Bob's WMo returns "ask_user" and surfaces a manual approval prompt.
// That is the guardrail: we deliberately avoid "*" (auto-run anything) and avoid
// deniedCommands (which hard-*rejects* without asking) so risky commands pause for
// a human (or, under the classifier policy, for Claude). A chained command (a && b)
// auto-runs only if every part matches.
// Arg-taking entries end in a space ("npm ") so they can't match a longer word.
// `ls`/`dir`/`pwd`/`tsc` are bare because they're valid with no args; they over-match
// (ls→lsof) but only read-only tools, and no destructive command shares their prefix
// (pinned by the SAFE_COMMANDS test).
// `cd ` is included because agents routinely prefix a safe command with it
// (`cd <workspace> && npm test`); since a chained command auto-runs only if EVERY part
// matches, allowing `cd ` doesn't enable a dangerous tail (`cd x && rm -rf` still asks).
export const SAFE_COMMANDS = [
  "npm ", "npx ", "pnpm ", "yarn ", "node ", "tsc", "cd ",
  "git ", "ls", "dir", "pwd", "cat ", "type ", "echo ",
  "grep ", "rg ", "findstr ", "python ", "python3 ", "pip ",
];

const STANDARD: ModeProfile = {
  risk: "standard",
  commandPolicy: "allowlist",
  autoApprove: {
    autoApprovalEnabled: true,
    alwaysAllowReadOnly: true,
    alwaysAllowWrite: true,
    alwaysAllowExecute: true,
    alwaysAllowMcp: true,
    alwaysAllowBrowser: false,
  },
};

// Read-only analysis profile shared by plan + review: reads and safe analysis
// commands are auto-run, but writes are off (alwaysAllowWrite:false) so the mode
// can't mutate code. Shared so the two never drift (the same reason `STANDARD`
// is shared by code/orchestrator/refactor/devsecops).
const READONLY_ANALYSIS: ModeProfile = {
  risk: "safe",
  commandPolicy: "allowlist",
  autoApprove: {
    autoApprovalEnabled: true,
    alwaysAllowReadOnly: true,
    alwaysAllowWrite: false,
    alwaysAllowExecute: true, // safe analysis commands (SAFE_COMMANDS only)
    alwaysAllowMcp: true,
    alwaysAllowBrowser: false,
  },
};

export const MODE_PROFILES: Record<string, ModeProfile> = {
  // Read-only: safe unattended; no writes/commands even if attempted.
  ask: {
    risk: "safe",
    commandPolicy: "none",
    autoApprove: {
      // Master on for reads/MCP; write+execute false, so a mutation still prompts.
      autoApprovalEnabled: true,
      alwaysAllowReadOnly: true,
      alwaysAllowWrite: false,
      alwaysAllowExecute: false,
      alwaysAllowMcp: true,
      alwaysAllowBrowser: false,
    },
  },
  // Plan mode: read-only analysis and planning, no code changes.
  plan: READONLY_ANALYSIS,
  // Review mode: read-only code review, can use submit_review_findings tool.
  review: READONLY_ANALYSIS,
  code: STANDARD,
  orchestrator: STANDARD,
  // Refactor mode: code editing with standard risk profile.
  refactor: STANDARD,
  // DevSecOps mode: code editing with security focus, standard risk profile.
  devsecops: STANDARD,
  // Adds Browser plus command power; gated above the default worker threshold.
  // Gray-zone commands route to the Claude classifier rather than a human.
  advanced: {
    risk: "elevated",
    commandPolicy: "classifier",
    autoApprove: {
      autoApprovalEnabled: true,
      alwaysAllowReadOnly: true,
      alwaysAllowWrite: true,
      alwaysAllowExecute: true,
      alwaysAllowMcp: true,
      alwaysAllowBrowser: true,
    },
  },
};

/** Safety profile for a mode slug; unknown/custom modes default to standard. */
export function profileFor(mode: string): ModeProfile {
  return MODE_PROFILES[mode] ?? STANDARD;
}

/**
 * True when the mode is read-only analysis (writes off): ask / plan / review.
 * These never edit code, so a diff-based check (the LLM judge) is meaningless for
 * them, and they should not arm the command classifier — a gray-zone command in a
 * read-only mode is an attempt to mutate, which must not be auto-approved.
 */
export function isReadOnlyMode(mode: string): boolean {
  return !profileFor(mode).autoApprove.alwaysAllowWrite;
}

// Modes whose completion_result text IS a structured review (severity-ranked
// findings) the worker parses onto the board, and which produce no code diff (so
// the LLM judge is skipped). Only `review` — Bob's native read-only code review,
// whose fix is a separate task (per IBM's docs). `devsecops` is NOT here: per IBM's
// shift-left model it's security embedded in coding — a write-capable fixer (STANDARD
// profile) whose diff the judge SHOULD verify, like `code`/`refactor`.
export const REVIEW_FINDING_MODES: ReadonlySet<string> = new Set(["review"]);

/** True when the mode returns review findings as its result (see REVIEW_FINDING_MODES). */
export function producesReviewFindings(mode: string): boolean {
  return REVIEW_FINDING_MODES.has(mode);
}

/**
 * True when a diff-based completion judge is meaningful for this mode: the mode is
 * expected to write code. Read-only and review-producing modes return prose/findings
 * with no diff, so judging them against an (empty) diff would wrongly fail them.
 */
export function judgeAppliesToMode(mode: string): boolean {
  return !isReadOnlyMode(mode) && !producesReviewFindings(mode);
}

/**
 * True if a command policy has a gray zone (commands outside the allowlist that
 * could be approved by the classifier). Both 'allowlist' and 'classifier' have
 * gray zones; 'none' and 'auto' do not.
 */
export function policyHasGrayZone(policy: CommandPolicy): boolean {
  return policy === "allowlist" || policy === "classifier";
}

/**
 * True if any mode with a gray zone (allowlist or classifier policy) is within
 * the risk gate. If none is, the classifier never fires (those tasks aren't
 * dispatched) — the worker warns on this. Read-only modes (plan/review) are
 * included: the classifier handles their gray-zone commands hands-off (e.g. a
 * security scanner), while their write tools stay disabled (alwaysAllowWrite:false).
 */
export function classifierReachable(maxRisk: Risk): boolean {
  const max = RISK_RANK[maxRisk];
  return Object.values(MODE_PROFILES).some(
    (p) => policyHasGrayZone(p.commandPolicy) && RISK_RANK[p.risk] <= max,
  );
}

// Workflow auto-approve toggles forced on for every dispatch. These gate Bob's own
// orchestration steps, not file/command actions: without them Bob stops at an Approve
// button every time it updates its todo list, spawns a subtask, or switches mode —
// the recurring "stalled after updateTodoList" wedge. They're benign (no file or shell
// side effects), so they're always on rather than per-mode. Resubmit auto-retries a
// transient API error instead of stalling at a "retry?" prompt.
const WORKFLOW_AUTO_APPROVE = {
  alwaysApproveResubmit: true,
  alwaysAllowUpdateTodoList: true,
  alwaysAllowSubtasks: true,
  alwaysAllowModeSwitch: true,
} as const;

/**
 * The autoApprove block sent to Bob on dispatch: the mode's bool toggles (incl. the
 * autoApprovalEnabled master switch), the allowedCommands list derived from its
 * commandPolicy, and the always-on workflow toggles. allowlist and classifier share
 * the SAFE_COMMANDS fast-path — the difference is what handles the gray zone (a human
 * prompt vs the Claude classifier), which happens Bob-side, not in this config.
 *
 * @param profile - The mode profile containing the command policy
 * @param extraCommands - Additional command prefixes to merge into the allowlist (from --allow-commands)
 */
export function dispatchAutoApprove(
  profile: ModeProfile,
  extraCommands: string[] = [],
): ModeProfile["autoApprove"] & { allowedCommands: string[] } & typeof WORKFLOW_AUTO_APPROVE {
  const baseCommands =
    profile.commandPolicy === "auto" ? ["*"] : profile.commandPolicy === "none" ? [] : SAFE_COMMANDS;
  // Merge extra commands into the base allowlist (on top of SAFE_COMMANDS for allowlist/classifier policies)
  const allowedCommands = profile.commandPolicy === "none" || profile.commandPolicy === "auto"
    ? baseCommands
    : [...baseCommands, ...extraCommands];
  return { ...profile.autoApprove, allowedCommands, ...WORKFLOW_AUTO_APPROVE };
}

export function resolveMode(task: Pick<Task, "mode" | "title" | "description" | "tags">): {
  mode: string;
  source: "explicit" | "tag" | "auto-router" | "default";
} {
  // Explicit mode wins.
  if (task.mode && task.mode.trim()) return { mode: task.mode.trim(), source: "explicit" };

  // A tag naming a mode is a type hint; case-insensitive, first match wins.
  for (const tag of task.tags) {
    const t = tag.toLowerCase();
    if (isBuiltInMode(t)) return { mode: t, source: "tag" };
  }

  const hay = `${task.title} ${task.description ?? ""} ${task.tags.join(" ")}`;
  const impl = looksLikeImplementation(hay);
  for (const rule of RULES) {
    // Never route an implementation task to read-only `ask` — that produces an
    // analysis with no code, which then can't honestly reach 'done'.
    if (rule.mode === "ask" && impl) continue;
    if (rule.re.test(hay)) return { mode: rule.mode, source: "auto-router" };
  }

  return { mode: DEFAULT_MODE, source: "default" };
}
