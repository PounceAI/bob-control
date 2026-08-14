import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bob2HomeDir } from "./bob2-config.js";
import { isReadOnlyMode } from "./modes.js";

// Will Bob 2.0 resolve this mode slug in this workspace? Worth asking up front because an unresolvable slug
// does NOT error: `startTask` → `handleInputMessage` posts "Invalid mode used." to the webview and returns,
// but `openTask` already created the task row — so the driver correlates a row that never runs, updated_at
// never passes created_at, and the dispatch burns its full wall clock to report a bare 'timeout'.
// Verified against Bob 2.0.3, 2026-08-14.

/** Bob 2.0.3's DEFAULT_MODES — all that resolves without a custom_modes.yaml. */
export const BOB2_BUILTIN_MODES: readonly string[] = ["agent", "plan", "ask"];

/**
 * Custom-mode slugs available in `workspaceDir`, read the way Bob reads them: the workspace's
 * `.bob/custom_modes.yaml` (where init-project-board.mjs puts our review/refactor/devsecops) plus the global
 * `~/.bob/settings/custom_modes.yaml`. Scraped, not parsed — only slugs matter and the repo carries no YAML
 * dep (init-project-board.mjs makes the same call). Over-reporting is the safe direction: a slug we wrongly
 * accept just restores the hang above, while one we wrongly miss would downgrade a working mode.
 */
export function customModeSlugs(workspaceDir: string | null): Set<string> {
  const files = [
    workspaceDir ? join(workspaceDir, ".bob", "custom_modes.yaml") : null,
    join(bob2HomeDir(), "settings", "custom_modes.yaml"),
  ];
  const slugs = new Set<string>();
  for (const f of files) {
    if (!f || !existsSync(f)) continue;
    let raw: string;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      continue; // unreadable config is not a dispatch failure — fall through to the built-ins
    }
    for (const m of raw.matchAll(/^\s*-?\s*slug:\s*["']?([A-Za-z0-9_-]+)["']?/gm)) slugs.add(m[1]);
  }
  return slugs;
}

/**
 * Where an unresolvable mode lands. Keyed on the safety profile rather than always `agent`: `ask` is the only
 * built-in with no `edit` group, so a read-only slug that lost its custom mode still can't rewrite the code it
 * was sent to inspect. It has no `execute` either — a degraded review can't run `git diff`, which is weaker
 * but weak in the safe direction.
 */
export function fallbackMode(mode: string): string {
  return isReadOnlyMode(mode) ? "ask" : "agent";
}

export interface ModeAvailability {
  /** The slug to dispatch — `mode` itself, or its fallback. */
  mode: string;
  /** Set only when a fallback was substituted. */
  warning?: string;
}

/** Resolve `mode` for `workspaceDir`. Reports and downgrades, never rejects — a project missing its
 *  custom_modes.yaml still gets a usable turn. */
export function resolveAvailableMode(mode: string, workspaceDir: string | null): ModeAvailability {
  if (BOB2_BUILTIN_MODES.includes(mode) || customModeSlugs(workspaceDir).has(mode)) return { mode };
  const to = fallbackMode(mode);
  const where = workspaceDir ? join(workspaceDir, ".bob", "custom_modes.yaml") : "<workspace>/.bob/custom_modes.yaml";
  return {
    mode: to,
    warning:
      `bob2: mode '${mode}' is not loaded in this workspace — running as '${to}'. ` +
      `Add it to ${where} (e.g. \`node tools/init-project-board.mjs <project>\`).`,
  };
}
