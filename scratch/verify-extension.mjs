#!/usr/bin/env node
// verify-extension.mjs — faithful, headless reproduction of what the bob-tasks
// VS Code extension does at runtime, so we can confirm the live (hardened)
// behaviour end-to-end without driving Bob's command palette.
//
// It spawns dist/worker.js with the SAME arg vector the extension builds
// (extension.ts startWorker), feeds stdout through the SAME StringDecoder /
// "@@WORKER " consume logic, runs the SAME handleEvent() switch, AND runs the
// SAME 30s connect watchdog (connectTimer). stdin is held open exactly like the
// VS Code extension host, so the --emit-json parent-death guard never fires.
//
// Two modes:
//   Happy path (real Bob):   node scratch/verify-extension.mjs --tag <tag>
//       expects connected -> taskStart -> taskDone, watchdog cleared by connected.
//   Watchdog (wedged IPC):   node scratch/verify-extension.mjs \
//       --pipe \\.\pipe\bobtasks-watchdog-test --connect-timeout 5000
//       (point at scratch/dummy-pipe-server.mjs) expects: no connected, watchdog
//       fires -> error toast + worker killed.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : def;
};
// back-compat: a bare first arg (no leading --) is the tag
const tag = argv[0] && !argv[0].startsWith("--") ? argv[0] : opt("--tag", undefined);
const pipe = opt("--pipe", "\\\\.\\pipe\\pipe\\bob-ipc");
const CONNECT_TIMEOUT_MS = Number(opt("--connect-timeout", "30000"));

const workerJs = path.join(root, "dist", "worker.js");

// Mirror extension.ts startWorker() arg construction (defaults from package.json).
const args = [
  workerJs,
  "--emit-json",
  "--no-notify",
  "--max-risk", "standard",
  "--poll", "3000",
  "--timeout", "300000",
  "--assignee", "bob",
  "--pipe", pipe,
  "--surface", "sidebar",
  "--defer-idle", "60000",
  "--no-defer",
];
if (tag) args.push("--tag", tag);

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (kind, msg) => console.log(`[${stamp()}] ${kind.padEnd(9)} ${msg}`);

log("SPAWN", `node ${args.join(" ")}`);
log("CONFIG", `connect watchdog = ${CONNECT_TIMEOUT_MS}ms`);
const child = spawn(process.execPath, args, { cwd: root, env: process.env });

let sawConnected = false;
let terminal = null; // "done" | "fail"
let watchdogFired = false;
let stopped = false; // mirrors `worker === null` after a deliberate stop

// --- exact copy of the extension's connect watchdog -------------------------
let connectTimer = setTimeout(() => {
  connectTimer = null;
  if (stopped) return; // extension guards with `worker !== child`
  log("WATCHDOG", `no 'connected' within ${CONNECT_TIMEOUT_MS}ms — stopping worker`);
  log("UI", `TOAST(err) "Bob Tasks: worker did not connect to Bob — is Bob running?"`);
  watchdogFired = true;
  stopWorker();
}, CONNECT_TIMEOUT_MS);
connectTimer.unref?.();

function clearWatchdog() {
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
}
function stopWorker() {
  clearWatchdog();
  stopped = true;
  child.kill();
}
// ---------------------------------------------------------------------------

// --- exact copy of the extension's stdout consume path ----------------------
let buf = "";
const decoder = new StringDecoder("utf8");
const consume = (line) => {
  const t = line.trim();
  if (t.startsWith("@@WORKER ")) handleEvent(t.slice(9));
  else if (t) log("stdout", t);
};
child.stdout.on("data", (d) => {
  buf += decoder.write(d);
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    consume(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
});
const errDecoder = new StringDecoder("utf8");
child.stderr.on("data", (d) => process.stderr.write(errDecoder.write(d)));
// ---------------------------------------------------------------------------

function handleEvent(json) {
  let ev;
  try { ev = JSON.parse(json); } catch { log("BADJSON", json); return; }
  log("EVENT", json);
  switch (ev.type) {
    case "connected":
      sawConnected = true;
      clearWatchdog(); // <-- the watchdog must be cleared here on the happy path
      log("UI", `status -> running  (connected to ${ev.pipe}, maxRisk=${ev.maxRisk}); watchdog cleared`);
      break;
    case "taskStart":
      log("UI", `status -> running #${ev.id} {${ev.mode}}`);
      break;
    case "taskDone":
      log("UI", `TOAST "Bob finished #${ev.id}: ${ev.title}"  (${ev.chars} chars)`);
      terminal = "done";
      log("STOP", "mirroring Stop Worker -> child.kill()");
      stopWorker();
      break;
    case "taskFail":
      log("UI", `TOAST(warn) "Bob task #${ev.id} ${ev.status}"`);
      terminal = "fail";
      stopWorker();
      break;
    case "idle":
      log("UI", `status -> idle ${ev.gated ? `(${ev.gated} gated)` : ""}`);
      break;
    case "deferred": log("UI", "status -> deferred (chat active)"); break;
    case "resumed":  log("UI", "status -> running"); break;
    case "error":    log("UI", `TOAST(err) "${ev.message ?? "unknown"}"`); break;
    case "stopped":  log("UI", "status -> stopped"); break;
  }
}

child.on("error", (err) => log("ERROR", err.message));
child.on("exit", (code, signal) => {
  clearWatchdog();
  buf += decoder.end();
  if (buf.trim()) consume(buf);
  log("EXIT", `worker exited (code ${code}, signal ${signal})`);

  const watchdogMode = CONNECT_TIMEOUT_MS < 30000 || watchdogFired;
  let ok;
  console.log("\n=== VERDICT ===");
  console.log(`connected event : ${sawConnected ? "YES" : "NO"}`);
  console.log(`watchdog fired  : ${watchdogFired ? "YES" : "NO"}`);
  console.log(`terminal event  : ${terminal ?? "none"}`);
  if (watchdogMode) {
    ok = watchdogFired && !sawConnected;
    console.log(ok
      ? "RESULT: PASS — worker hung (no connected), watchdog fired -> error toast + worker killed"
      : "RESULT: FAIL — expected the watchdog to fire on a silent hang");
  } else {
    ok = sawConnected && terminal === "done";
    console.log(ok
      ? "RESULT: PASS — connected -> taskStart -> taskDone observed end-to-end"
      : "RESULT: FAIL — see stream above");
  }
  process.exit(ok ? 0 : 1);
});

// Safety net: don't hang forever (well past the watchdog window).
const guard = setTimeout(() => {
  log("TIMEOUT", "safety net reached — killing worker");
  stopWorker();
}, Math.max(CONNECT_TIMEOUT_MS + 15_000, 180_000));
guard.unref?.();
