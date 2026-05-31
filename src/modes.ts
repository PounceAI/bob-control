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

export interface ModeProfile {
  risk: Risk;
  autoApprove: {
    alwaysAllowReadOnly: boolean;
    alwaysAllowWrite: boolean;
    alwaysAllowExecute: boolean;
    alwaysAllowMcp: boolean;
    alwaysAllowBrowser: boolean;
  };
}

const STANDARD: ModeProfile = {
  risk: "standard",
  autoApprove: {
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
    autoApprove: {
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
  advanced: {
    risk: "elevated",
    autoApprove: {
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
