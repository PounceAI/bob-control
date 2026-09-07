// Bob 2.1 lifecycle hooks for the in-process driver. Bob runs each hook command through exec with one JSON
// object on stdin (`session_id` = the bob.db task id). Stop → hook-stop.js writes a completion marker the driver
// polls for; PreToolUse on execute_command → hook-pretool.js exits 2 to block a policy-denied command. Both live
// in Bob's user-global settings.json beside the auto-approve keys; ours are recognised by script filename.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STOP_HOOK_FILE = "hook-stop.js";
export const PRETOOL_HOOK_FILE = "hook-pretool.js";
const HOOK_FILES = [STOP_HOOK_FILE, PRETOOL_HOOK_FILE];

/** Where Stop markers go. `BOB_CONTROL_HOOK_DIR` overrides (tests; a non-default Bob home). */
export function stopMarkerDir(home = join(homedir(), ".bob")): string {
  return process.env.BOB_CONTROL_HOOK_DIR || join(home, "tmp", "bob-control-hooks", "stop");
}

export interface StopMarker {
  session_id: string;
  cwd?: string;
  /** Wall-clock ms when the hook ran. */
  at: number;
  last_assistant_message?: string | null;
}

export function writeStopMarker(
  dir: string,
  payload: { session_id: string; cwd?: string; last_assistant_message?: string | null },
  now = Date.now(),
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeName(payload.session_id)}.json`);
  const marker: StopMarker = {
    session_id: payload.session_id,
    cwd: payload.cwd,
    at: now,
    last_assistant_message: payload.last_assistant_message ?? null,
  };
  writeFileSync(file, JSON.stringify(marker));
  return file;
}

/** The marker for `sessionId` written at or after `sinceMs`, else null. Never throws — an unreadable or
 *  stale marker just means "no signal", and the driver falls back to the quiescence watch. */
export function readStopMarker(dir: string, sessionId: string, sinceMs = 0): StopMarker | null {
  const file = join(dir, `${safeName(sessionId)}.json`);
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as StopMarker;
    if (!m || typeof m.at !== "number" || m.session_id !== sessionId) return null;
    return m.at >= sinceMs ? m : null;
  } catch {
    return null;
  }
}

export function removeStopMarker(dir: string, sessionId: string): void {
  try {
    unlinkSync(join(dir, `${safeName(sessionId)}.json`));
  } catch {
    /* absent */
  }
}

/** Delete markers older than `olderThanMs` (the global hook fires for every Bob task, not just ours). */
export function pruneStopMarkers(dir: string, olderThanMs: number, now = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > olderThanMs) {
        unlinkSync(p);
        n++;
      }
    } catch {
      /* raced / unreadable — skip */
    }
  }
  return n;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Quote one command-line part unless it is plainly safe. exec's `cmd /d /s /c` and `sh -c` both keep inner
 *  double quotes. */
export function shellArg(p: string): string {
  if (/^[A-Za-z0-9_.:\\/=,+@-]+$/.test(p)) return p;
  // \" is the one escape both sides honor: the CRT argv parser node.exe uses on Windows and sh's double quotes.
  return `"${p.replace(/"/g, '\\"')}"`;
}

// Still expanded or split inside double quotes by cmd.exe or sh. The command is persisted globally and re-run on
// every Bob task from settings-derived parts, so these are refused, not quoted.
const SHELL_ACTIVE = /[$`%^&|<>;\r\n]/;

/** `<node> <script> [args…]` as one command line; throws on a part no quoting makes safe. */
export function hookCommand(node: string, script: string, args: string[] = []): string {
  const parts = [node, script, ...args];
  const bad = parts.find((p) => SHELL_ACTIVE.test(p));
  if (bad !== undefined) throw new Error(`hook command part contains shell-active characters: ${JSON.stringify(bad)}`);
  return parts.map(shellArg).join(" ");
}

export interface HookCommands {
  /** The Stop hook command; `null` removes ours; `undefined` leaves the event untouched. */
  stop?: string | null;
  /** The PreToolUse (execute_command) hook command; same null/undefined semantics. */
  preToolUse?: string | null;
}

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number; disabled?: boolean }[];
}

const isOurs = (g: HookGroup) => (g.hooks ?? []).some((h) => HOOK_FILES.some((f) => (h.command ?? "").includes(f)));

/** Merge our hooks into a settings object (pure): foreign groups kept, an earlier group of ours replaced, so
 *  repeated writes converge. Short timeouts — a hung hook would stall every Bob turn. */
export function mergeHooks(current: Record<string, unknown>, cmds: HookCommands): Record<string, unknown> {
  const hooks = { ...((current.hooks as Record<string, unknown> | undefined) ?? {}) };
  const set = (event: string, cmd: string | null | undefined, group: (c: string) => HookGroup) => {
    if (cmd === undefined) return;
    const others = (Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []).filter((g) => !isOurs(g));
    const next = cmd === null ? others : [...others, group(cmd)];
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  };
  set("Stop", cmds.stop, (command) => ({ hooks: [{ type: "command", command, timeout: 5 }] }));
  set("PreToolUse", cmds.preToolUse, (command) => ({
    matcher: "^execute_command$",
    hooks: [{ type: "command", command, timeout: 5 }],
  }));
  return { ...current, hooks };
}
