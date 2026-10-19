import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mergeHooks, type HookCommands } from "./hooks.js";
import { evaluateCommand } from "./command-policy.js";

// Bob 2.0's auto-approve config. Replaces the 1.x set-bob-autoapprove.mjs (which wrote state.vscdb
// globalState keys that no longer exist). 2.0's source of truth is ~/.bob/settings/settings.json
// (global) — verified live 2026-06-26 to drive headless approval, incl. the review finish tool. The
// per-task approval_config DB column is the finer-grained alternative but stays UNVERIFIED — see
// docs/bob-2-inprocess.md V7.

/** Bob 2.0's per-user config root (`~/.bob`) and its global settings file. */
export function bob2HomeDir(): string {
  return join(homedir(), ".bob");
}
export function bob2SettingsPath(): string {
  return join(bob2HomeDir(), "settings", "settings.json");
}

/** Permission categories the connector auto-approves for headless dispatch (enumerated from the bob-code
 *  bundle's tool declarations, 2026-06-26). A tool auto-approves only when its `permission` is in
 *  `allowed_permissions`, so a missing category silently prompts even under "auto-approve everything":
 *  `review` gates `submit_review_findings` (Bob's finish-the-review tool — a headless review wedged on it);
 *  `subtask`/`workflow` gate sub-agent / workflow spawning (granted for headless agentic work — note the only
 *  cap is the dispatch-time maxRisk gate, none per-spawn). Deliberately OMITS Bob's 14th category `ask`: it
 *  gates the human-input tool, and auto-approving it would swallow that escalation checkpoint while buying
 *  nothing (2.0 has no reply channel, so an ask wedges a headless run either way) — better to let it surface. */
export const ALL_PERMISSIONS = [
  "read",
  "edit",
  "execute",
  "mcp",
  "skill",
  "todo",
  "artifact",
  "subagent",
  "subtask",
  "workflow",
  "review",
  "mode",
] as const;

/** Marks a connector whose writeAutoApprove takes AutoApproveOptions; an older one writes the no-op `["*"]`. */
export const AUTO_APPROVE_VERSION = 2;

/**
 * Commands Bob 2.x auto-runs. Bob matches whole tokens from the command's start (case-sensitive, no wildcard)
 * and this file governs every Bob session, interactive ones too, so it's a narrow subset of command-policy's
 * allowlist (pinned by a test). Omitted on purpose: shell readers (read_file covers the workspace; these only
 * reach outside it), interpreters (inline `-e`/`-c` can't be fenced with token prefixes), and git that discards
 * work. Residual: `git diff --no-index` reads any file.
 */
export const BOB_HEADLESS_COMMANDS: readonly string[] = [
  "ls", "dir", "pwd", "cd",
  "git status", "git diff", "git log", "git rev-parse", "git ls-files", "git add", "git commit",
  "tsc", "npm test", "npm run", "pnpm test", "pnpm run", "yarn test", "yarn run",
  "pytest", "python -m pytest", "python3 -m pytest", "uv run pytest", "uv run python -m pytest",
  "make test", "make lint", "make check",
]; // prettier-ignore

export interface AutoApproveOptions {
  /** `bobTasks.allowCommands` / `--allow-commands` extras. */
  allow?: readonly string[];
  /** `bobTasks.denyCommands` / `--deny-commands`, used only to vet the extras. */
  deny?: readonly string[];
}

/** approvedCommands plus the refused extras. An extra must name a subcommand (a bare `git` would auto-run
 *  `git push`) and pass the policy with the user's denies applied. */
export function headlessCommands(opts: AutoApproveOptions = {}): { approved: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of opts.allow ?? []) {
    const p = raw.trim().split(/\s+/).join(" ");
    if (!p) continue;
    const ok = p.includes(" ") && evaluateCommand(p, { allow: [p], deny: [...(opts.deny ?? [])] }).decision === "allow";
    (ok ? kept : dropped).push(p);
  }
  return { approved: [...new Set([...BOB_HEADLESS_COMMANDS, ...kept])], dropped };
}

/**
 * The config that runs Bob 2.x unattended: every permission group inside the workspace, headlessCommands(),
 * and no LLM "dangerous command" check (`isCommandSecurityEnabled`). Outside-workspace calls still prompt.
 * Config can't fix `a && b` on Windows: powershell.exe 5.1 fails to parse it, so it always prompts.
 */
export function autoApproveSettings(opts: AutoApproveOptions = {}): Record<string, unknown> {
  return {
    isCommandSecurityEnabled: false,
    approval: {
      autoApprovalEnabled: true,
      outsideWorkspaceAllowed: true,
      allowed_permissions: [...ALL_PERMISSIONS],
      allowedExecutors: [
        { toolId: "execute_command", approvedCommands: headlessCommands(opts).approved, deniedCommands: [] },
      ],
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Overlay our config onto existing settings. We replace only the keys autoApproveSettings writes and
 *  execute_command's approvedCommands; the user's other approval keys, executors and deniedCommands survive,
 *  so a deny they added never becomes an auto-run. Pure. */
export function mergeAutoApprove(
  current: Record<string, unknown>,
  opts: AutoApproveOptions = {},
): Record<string, unknown> {
  const ours = autoApproveSettings(opts);
  const ourApproval = ours.approval as Record<string, unknown>;
  const [ourExec] = ourApproval.allowedExecutors as Record<string, unknown>[];
  const prev = isRecord(current.approval) ? current.approval : {};
  const prevExecs = (Array.isArray(prev.allowedExecutors) ? prev.allowedExecutors : []).filter(isRecord);
  const prevExec = prevExecs.find((e) => e.toolId === "execute_command");
  const userDenied = Array.isArray(prevExec?.deniedCommands)
    ? prevExec.deniedCommands.filter((s): s is string => typeof s === "string")
    : [];
  return {
    ...current,
    ...ours,
    approval: {
      ...prev,
      ...ourApproval,
      allowedExecutors: [
        ...prevExecs.filter((e) => e !== prevExec),
        { ...ourExec, deniedCommands: [...new Set(userDenied)] },
      ],
    },
  };
}

/** Write the auto-approve config into settings.json (default: the global file), keeping other keys.
 *  Blast radius: user-global, so every Bob window and project (interactive chats too) auto-runs
 *  headlessCommands(), and nothing reverts it on stop or uninstall. The extension gates it behind
 *  `bobTasks.autoApproveGlobal` and a one-time notice. */
export function writeAutoApprove(
  path = bob2SettingsPath(),
  opts: AutoApproveOptions = {},
): { path: string; created: boolean; approved: number; dropped: string[] } {
  const { approved, dropped } = headlessCommands(opts);
  return { ...updateSettings(path, (current) => mergeAutoApprove(current, opts)), approved: approved.length, dropped };
}

/** Install (or remove, per null) our lifecycle hooks in settings.json — same file, same atomic write and
 *  same refuse-to-clobber rules as the auto-approve config. See hooks.ts. */
export function writeHooks(cmds: HookCommands, path = bob2SettingsPath()): { path: string; created: boolean } {
  return updateSettings(path, (current) => mergeHooks(current, cmds));
}

/** Read settings.json (or start empty), apply `mutate`, write back atomically. */
function updateSettings(
  path: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): { path: string; created: boolean } {
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
  // Atomic write (temp + rename): a crash or a concurrent Bob read can't observe a truncated file — rename
  // is atomic on the same volume, so settings.json is never left half-written. If the rename itself fails
  // (cross-volume, permission), unlink the temp file rather than orphan it beside settings.json.
  // Random suffix (not a fixed `.tmp`): a local attacker can't pre-place a symlink at a predictable temp
  // path to redirect this write to an arbitrary file (TOCTOU on the temp name — CWE-377).
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(mutate(current), null, 2) + "\n");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
  return { path, created: !existed };
}
