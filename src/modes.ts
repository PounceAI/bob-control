import type { Task } from "./types.js";

// Bob's built-in modes. `mode` is stored as a free string so custom Roo
// .roomodes slugs work too; setting configuration.mode on dispatch switches Bob.
export const BUILT_IN_MODES = ["code", "advanced", "ask", "orchestrator"] as const;
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
export const SAFE_COMMANDS = [
  "npm ", "npx ", "pnpm ", "yarn ", "node ", "tsc",
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
  code: STANDARD,
  orchestrator: STANDARD,
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
 * True if any classifier-policy mode is within the risk gate. If none is, the
 * classifier never fires (those tasks aren't dispatched) — the worker warns on this.
 */
export function classifierReachable(maxRisk: Risk): boolean {
  const max = RISK_RANK[maxRisk];
  return Object.values(MODE_PROFILES).some(
    (p) => p.commandPolicy === "classifier" && RISK_RANK[p.risk] <= max,
  );
}

/**
 * The autoApprove block sent to Bob on dispatch: the mode's bool toggles (incl. the
 * autoApprovalEnabled master switch) plus the allowedCommands list derived from its
 * commandPolicy. allowlist and classifier share the SAFE_COMMANDS fast-path — the
 * difference is what handles the gray zone (a human prompt vs the extension's Claude
 * classifier), which happens Bob-side, not in this config. alwaysApproveResubmit is
 * forced on so a transient API error retries instead of stalling at a "retry?" prompt.
 */
export function dispatchAutoApprove(profile: ModeProfile): ModeProfile["autoApprove"] & {
  allowedCommands: string[];
  alwaysApproveResubmit: boolean;
} {
  const allowedCommands =
    profile.commandPolicy === "auto" ? ["*"] : profile.commandPolicy === "none" ? [] : SAFE_COMMANDS;
  return { ...profile.autoApprove, allowedCommands, alwaysApproveResubmit: true };
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
  for (const rule of RULES) {
    if (rule.re.test(hay)) return { mode: rule.mode, source: "auto-router" };
  }

  return { mode: DEFAULT_MODE, source: "default" };
}
