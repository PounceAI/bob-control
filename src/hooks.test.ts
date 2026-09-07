import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hookCommand,
  mergeHooks,
  pruneStopMarkers,
  readStopMarker,
  removeStopMarker,
  shellArg,
  stopMarkerDir,
  writeStopMarker,
} from "./hooks.js";
import { writeHooks } from "./bob2-config.js";

// Bob 2.1 lifecycle hooks: the settings merge is pure and idempotent, the Stop markers round-trip through
// files, and the two hook scripts behave as Bob will drive them (JSON on stdin, exit code as the verdict).

const tmp = () => mkdtempSync(join(tmpdir(), "bob-hooks-"));

test("shellArg / hookCommand: bare when safe, quoted when a path has spaces or an arg has metacharacters", () => {
  assert.equal(shellArg("C:/nvm/node.exe"), "C:/nvm/node.exe");
  assert.equal(shellArg("C:\\Program Files\\nodejs\\node.exe"), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(shellArg("rm -rf,git push"), '"rm -rf,git push"');
  assert.equal(shellArg("a&b"), '"a&b"');
  // A settings-derived part that a shell would still expand or split is refused, never quoted-and-hoped.
  for (const bad of ["$(curl x|sh)", "`id`", "%TEMP%", "a&b", "c;d", "line\nbreak"]) {
    assert.throws(() => hookCommand("node", "hook-pretool.js", ["--deny", bad]), /shell-active/, bad);
  }
  assert.throws(() => hookCommand("node", "C:/x/hook-stop.js|evil"), /shell-active/);
  assert.equal(shellArg('say "hi"'), '"say \\"hi\\""'); // escaped, never stripped
  assert.equal(hookCommand("node", "C:/c/dist/hook-stop.js"), "node C:/c/dist/hook-stop.js");
  assert.equal(
    hookCommand("node", "C:/c d/dist/hook-pretool.js", ["--deny", "curl,wget"]),
    'node "C:/c d/dist/hook-pretool.js" --deny curl,wget',
  );
});

test("mergeHooks installs both hooks, keeps foreign groups, replaces ours on rewrite, removes on null", () => {
  const current = {
    approval: { autoApprovalEnabled: true },
    hooks: { PreToolUse: [{ matcher: "^write_file$", hooks: [{ type: "command", command: "lint.sh" }] }] },
  };
  const once = mergeHooks(current, { stop: "node stop/hook-stop.js", preToolUse: "node pre/hook-pretool.js" });
  const twice = mergeHooks(once, { stop: "node stop2/hook-stop.js", preToolUse: "node pre2/hook-pretool.js" });
  const hooks = twice.hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  assert.equal(twice.approval, current.approval); // untouched
  assert.deepEqual(
    hooks.PreToolUse.map((g) => [g.matcher, g.hooks[0].command]),
    [
      ["^write_file$", "lint.sh"],
      ["^execute_command$", "node pre2/hook-pretool.js"],
    ],
  );
  assert.deepEqual(
    hooks.Stop.map((g) => g.hooks[0].command),
    ["node stop2/hook-stop.js"],
  );
  const removed = mergeHooks(twice, { stop: null, preToolUse: null }).hooks as Record<string, unknown[]>;
  assert.equal(removed.Stop, undefined); // nothing left under the event → key dropped, not an empty array
  assert.equal(removed.PreToolUse.length, 1); // the foreign lint hook survives
  const untouched = mergeHooks(twice, {}).hooks as Record<string, unknown[]>;
  assert.equal(untouched.Stop.length, 1);
});

test("writeHooks round-trips through settings.json, preserving the auto-approve keys", () => {
  const dir = tmp();
  const path = join(dir, "settings", "settings.json");
  writeFileSync(join(dir, "x"), ""); // dir exists; settings/ does not yet
  const r = writeHooks({ stop: "node hook-stop.js" }, path);
  assert.equal(r.created, true);
  writeHooks({ preToolUse: "node hook-pretool.js --deny curl" }, path);
  const s = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(s.hooks.Stop[0].hooks[0].command, "node hook-stop.js");
  assert.equal(s.hooks.PreToolUse[0].matcher, "^execute_command$");
  rmSync(dir, { recursive: true, force: true });
});

test("stop markers: write, read gated by sinceMs, remove, prune by age; the dir honors the env override", () => {
  const dir = tmp();
  const at = 1_000_000;
  writeStopMarker(dir, { session_id: "task/1", last_assistant_message: "done" }, at);
  assert.equal(readStopMarker(dir, "task/1", at + 1), null); // predates the dispatch
  assert.equal(readStopMarker(dir, "task/1", at)?.last_assistant_message, "done");
  assert.equal(readStopMarker(dir, "other", 0), null);
  writeFileSync(join(dir, "broken.json"), "{not json");
  assert.equal(readStopMarker(dir, "broken", 0), null);
  removeStopMarker(dir, "task/1");
  assert.equal(readStopMarker(dir, "task/1", 0), null);
  const old = join(dir, "old.json");
  writeFileSync(old, "{}");
  utimesSync(old, new Date(Date.now() - 48 * 3600_000), new Date(Date.now() - 48 * 3600_000));
  assert.equal(pruneStopMarkers(dir, 24 * 3600_000), 1);
  assert.ok(!existsSync(old) && existsSync(join(dir, "broken.json")));
  process.env.BOB_CONTROL_HOOK_DIR = dir;
  try {
    assert.equal(stopMarkerDir(), dir);
  } finally {
    delete process.env.BOB_CONTROL_HOOK_DIR;
  }
  assert.match(stopMarkerDir("/home/u/.bob").replace(/\\/g, "/"), /\/home\/u\/\.bob\/tmp\/bob-control-hooks\/stop$/);
  rmSync(dir, { recursive: true, force: true });
});

const DIST = join(process.cwd(), "dist");
const runHook = (script: string, input: unknown, args: string[] = [], env: Record<string, string> = {}) => {
  try {
    const stdout = execFileSync(process.execPath, [join(DIST, script), ...args], {
      input: JSON.stringify(input),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout.toString(), stderr: "" };
  } catch (e) {
    const err = e as { status: number | null; stdout: Buffer; stderr: Buffer };
    return { code: err.status ?? -1, stdout: err.stdout.toString(), stderr: err.stderr.toString() };
  }
};

test("hook-stop.js writes the marker for Bob's Stop payload and never fails on junk input", () => {
  const dir = tmp();
  const r = runHook(
    "hook-stop.js",
    { session_id: "abc123", cwd: "C:/ws", hook_event_name: "Stop", last_assistant_message: "All done." },
    [],
    { BOB_CONTROL_HOOK_DIR: dir },
  );
  assert.equal(r.code, 0);
  const m = readStopMarker(dir, "abc123", 0);
  assert.equal(m?.last_assistant_message, "All done.");
  assert.equal(m?.cwd, "C:/ws");
  assert.equal(runHook("hook-stop.js", "not an object", [], { BOB_CONTROL_HOOK_DIR: dir }).code, 0);
  assert.equal(readdirSync(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("hook-pretool.js blocks a denied command with exit 2 + reason, passes allowed/unknown/other tools", () => {
  const pre = (tool: string, command: string, args: string[] = []) =>
    runHook(
      "hook-pretool.js",
      { session_id: "t", cwd: "C:/ws", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } },
      args,
    );
  const denied = pre("execute_command", "git push origin main");
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /blocked this command/);
  assert.equal(pre("execute_command", "npm test").code, 0);
  assert.equal(pre("execute_command", "some-unknown-tool --flag").code, 0); // unknown is not denied here
  assert.equal(pre("execute_command", "make deploy", ["--deny", "make deploy"]).code, 2);
  assert.equal(pre("write_file", "git push").code, 0); // not a command tool
  assert.equal(runHook("hook-pretool.js", "junk").code, 0);
});
