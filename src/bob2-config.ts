import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

// Bob 2.0's auto-approve config. Replaces the 1.x set-bob-autoapprove.mjs (which wrote state.vscdb
// globalState keys that no longer exist). 2.0's source of truth is ~/.bob/settings/settings.json
// (global) + the per-task approval_config DB column. UNVERIFIED against a live 2.0 — see
// docs/bob-2-inprocess.md V7.

/** Bob 2.0's per-user config root (`~/.bob`) and its global settings file. */
export function bob2HomeDir(): string {
  return join(homedir(), ".bob");
}
export function bob2SettingsPath(): string {
  return join(bob2HomeDir(), "settings", "settings.json");
}

/** Bob 2.0's permission categories (the `allowed_permissions` enum). */
export const ALL_PERMISSIONS = [
  "read",
  "edit",
  "execute",
  "mcp",
  "skill",
  "todo",
  "artifact",
  "subagent",
  "mode",
] as const;

/**
 * The config that makes Bob 2.0 run unattended: auto-approve every permission, allow any command via
 * the executor wildcard, permit out-of-workspace writes, AND disable the command security gate
 * (`isCommandSecurityEnabled`) — which otherwise refuses "dangerous" commands BEFORE the allow-list
 * is consulted. Residual wedge: a command Bob's parser can't verify still prompts even with `["*"]`.
 */
export function autoApproveSettings(): Record<string, unknown> {
  return {
    isCommandSecurityEnabled: false,
    approval: {
      autoApprovalEnabled: true,
      outsideWorkspaceAllowed: true,
      allowed_permissions: [...ALL_PERMISSIONS],
      permissionOptions: [],
      allowedExecutors: [{ toolId: "execute_command", approvedCommands: ["*"], deniedCommands: [] }],
    },
  };
}

/**
 * Overlay the auto-approve config onto an existing settings object, preserving keys we don't own
 * (Bob keeps auth/telemetry/modes there). `approval` and `isCommandSecurityEnabled` are OUR policy,
 * so they're replaced wholesale. Pure; file I/O lives in writeAutoApprove.
 */
export function mergeAutoApprove(current: Record<string, unknown>): Record<string, unknown> {
  return { ...current, ...autoApproveSettings() };
}

/** Write the auto-approve config into settings.json (default: the global file), keeping other keys. */
export function writeAutoApprove(path = bob2SettingsPath()): { path: string; created: boolean } {
  const existed = existsSync(path);
  let current: Record<string, unknown> = {};
  if (existed) {
    // We replace only our policy keys and preserve Bob's others — so if the existing file can't be
    // read+parsed into an object, REFUSE rather than overwrite (a clobber would destroy auth/modes/etc.).
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`bob2 auto-approve: cannot read ${path} (${(e as Error).message}); refusing to overwrite it`);
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip a UTF-8 BOM; JSON.parse rejects it
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`bob2 auto-approve: ${path} is not valid JSON; fix or remove it before enabling auto-approve`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`bob2 auto-approve: ${path} is not a JSON object; refusing to overwrite it`);
    }
    current = parsed as Record<string, unknown>;
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  // Atomic write (temp + rename): a crash or a concurrent Bob read can't observe a truncated file —
  // rename is atomic on the same volume, so settings.json is never left half-written.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(mergeAutoApprove(current), null, 2) + "\n");
  renameSync(tmp, path);
  return { path, created: !existed };
}
