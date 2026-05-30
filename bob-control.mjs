#!/usr/bin/env node
// bob-control — drive IBM Bob programmatically over its Roo Code IPC socket.
//
// Bob (ibm.bob-code) starts a node-ipc server ONLY when the env var
// ROO_CODE_IPC_SOCKET_PATH is set at launch. This client connects to that
// pipe, waits for the server's Ack (which carries our clientId), then sends
// TaskCommands and streams back TaskEvents.
//
// Wire format (from Bob's bundle): node-ipc, utf8, rawBuffer=false,
// delimiter "\f" — i.e. each message is JSON.stringify(msg) + "\f".
//
// Usage:
//   node bob-control.mjs "your prompt for Bob"      start a task, stream events
//   node bob-control.mjs --new-tab "prompt"         open the task in a new tab
//   node bob-control.mjs --cancel <taskId>          cancel a running task
//   node bob-control.mjs --list-pipes               list candidate Bob pipes
//   node bob-control.mjs --keep-open "prompt"       don't auto-exit on completion
//   node bob-control.mjs --mode ask "prompt"        run the task in a specific Bob mode
// Flags: --pipe <path>  --timeout <ms>  --quiet  --mode <slug>
//   mode slugs: code | advanced | ask | orchestrator (or any custom mode slug)
import net from "node:net";
import { readdirSync } from "node:fs";

const DELIM = "\f";
const argv = process.argv.slice(2);

function takeFlagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
function takeFlag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

const listPipes = takeFlag("--list-pipes");
const newTab = takeFlag("--new-tab");
const keepOpen = takeFlag("--keep-open");
const quiet = takeFlag("--quiet");
const cancelId = takeFlagValue("--cancel");
const pipeArg = takeFlagValue("--pipe");
const mode = takeFlagValue("--mode");
const timeoutMs = Number(takeFlagValue("--timeout") ?? 600000);
const prompt = argv.join(" ").trim();

const PIPE =
  pipeArg ?? process.env.ROO_CODE_IPC_SOCKET_PATH ?? "\\\\.\\pipe\\bob-ipc";

// --- Discover candidate named pipes (Windows), useful if node-ipc mangled the path.
function discoverPipes() {
  try {
    return readdirSync("\\\\.\\pipe\\");
  } catch {
    return [];
  }
}

if (listPipes) {
  const all = discoverPipes();
  const hits = all.filter((p) => /bob|ipc|app\.|roo/i.test(p));
  console.log(`named pipes (${all.length} total). likely Bob/IPC candidates:`);
  for (const p of hits.length ? hits : all.slice(0, 40)) console.log("  \\\\.\\pipe\\" + p);
  if (!hits.length) console.log("  (no obvious 'bob'/'ipc' pipe — is Bob running with ROO_CODE_IPC_SOCKET_PATH set?)");
  process.exit(0);
}

if (!prompt && !cancelId) {
  console.error('error: provide a prompt, e.g.  node bob-control.mjs "review src/db.ts"');
  process.exit(1);
}

const log = (...a) => !quiet && console.error(...a);

const sock = net.connect(PIPE);
let buffer = "";
let clientId = null;
let sentCommand = false;
let ourTaskId = null;
const seenTasks = new Set();

const killTimer = setTimeout(() => {
  log(`\n[bob-control] timeout after ${timeoutMs}ms — closing.`);
  sock.end();
  process.exit(0);
}, timeoutMs);
killTimer.unref?.();

function send(obj) {
  // node-ipc wire format: the real IpcMessage rides inside a {type:"message"} envelope.
  sock.write(JSON.stringify({ type: "message", data: obj }) + DELIM);
}

sock.on("connect", () => log(`[bob-control] connected to ${PIPE} — waiting for Ack…`));

sock.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf(DELIM)) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!raw.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log("[bob-control] non-JSON frame:", raw.slice(0, 120));
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  // Unwrap node-ipc's {type:"message", data:<IpcMessage>} envelope.
  if (msg && msg.type === "message" && msg.data) msg = msg.data;
  if (msg.type === "Ack") {
    clientId = msg.data?.clientId;
    log(`[bob-control] Ack received. clientId=${clientId} (Bob pid=${msg.data?.pid})`);
    if (cancelId) {
      send({ type: "TaskCommand", origin: "client", clientId, data: { commandName: "CancelTask", data: cancelId } });
      log(`[bob-control] sent CancelTask -> ${cancelId}`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (!sentCommand) {
      sentCommand = true;
      send({
        type: "TaskCommand",
        origin: "client",
        clientId,
        data: {
          commandName: "StartNewTask",
          data: { configuration: mode ? { mode } : {}, text: prompt, newTab },
        },
      });
      log(
        `[bob-control] StartNewTask sent${mode ? ` (mode=${mode})` : ""}. Bob is working — streaming events:\n`,
      );
    }
    return;
  }

  if (msg.type === "TaskEvent") {
    const ev = msg.data ?? {};
    const name = ev.eventName ?? ev.event ?? ev.type ?? "event";
    const payload = ev.payload ?? ev.data ?? ev;
    // Lifecycle events (taskCreated/taskCompleted/…) deliver the payload as a
    // positional array whose first element is the bare taskId string; chat
    // events deliver [{taskId, message, …}]. Cover both.
    const taskId =
      payload?.taskId ??
      (Array.isArray(payload)
        ? typeof payload[0] === "string"
          ? payload[0]
          : payload[0]?.taskId
        : undefined);
    // Bind to OUR task — the first one created/started after we sent StartNewTask.
    // Terminal events for other tasks (e.g. the prior task aborting when we reuse
    // the tab) must NOT close us.
    if (!ourTaskId && taskId && /taskCreated|taskStarted/i.test(String(name))) {
      ourTaskId = taskId;
      log(`[bob-control] task id = ${taskId}  (cancel with: node bob-control.mjs --cancel ${taskId})`);
    }
    if (taskId) seenTasks.add(taskId);
    printEvent(name, payload);
    const terminal = /taskCompleted|taskAborted|TaskCompleted|TaskAborted/.test(String(name));
    if (!keepOpen && terminal && ourTaskId && taskId === ourTaskId) {
      log(`\n[bob-control] task finished (${name}). closing.`);
      sock.end();
      setTimeout(() => process.exit(0), 200);
    }
    return;
  }

  log("[bob-control] message:", JSON.stringify(msg).slice(0, 200));
}

function printEvent(name, payload) {
  // Bob's chat events carry a ClineMessage; it can be at payload.message or
  // payload[0].message (node-ipc sometimes delivers the args as an array).
  const arr = Array.isArray(payload) ? payload : [payload];
  const cline = arr.map((p) => p?.message ?? p).find((m) => m && (m.text || m.say || m.ask));
  if (cline && (cline.text || cline.say || cline.ask)) {
    const kind = cline.say ?? cline.ask ?? cline.type ?? "";
    const text = String(cline.text ?? "").replace(/\s+/g, " ").trim();
    const tag = kind ? `${name}/${kind}` : name;
    console.log(text ? `  ${tag}: ${text.slice(0, 1000)}` : `  ${tag}`);
  } else {
    console.log(`  ${name}`);
  }
}

sock.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error(`\n[bob-control] could not find the pipe: ${PIPE}`);
    console.error("Is Bob running, launched WITH ROO_CODE_IPC_SOCKET_PATH set?");
    console.error("Try:  node bob-control.mjs --list-pipes");
  } else {
    console.error("[bob-control] socket error:", err.message);
  }
  process.exit(1);
});

sock.on("close", () => log("[bob-control] connection closed."));
