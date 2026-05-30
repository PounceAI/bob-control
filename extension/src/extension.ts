import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import * as path from "path";

/**
 * Bob Tasks extension. Drives dist/worker.js as a child process (real Node >=22.5
 * so node:sqlite works) and wraps it with VS Code UI: settings map to worker flags,
 * native notifications come from the worker's @@WORKER {json} stream, plus optional
 * bring-to-front focus, start/stop commands, and a status-bar item.
 */

let worker: ChildProcessWithoutNullStreams | null = null;
let starting = false; // set between spawn() and child going live; blocks double-start
let connectTimer: ReturnType<typeof setTimeout> | null = null; // startup watchdog
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel;

const CONNECT_TIMEOUT_MS = 30_000;

export function activate(context: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel("Bob Tasks");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "bobTasks.toggleWorker";
  context.subscriptions.push(out, status);
  setStatus("stopped");
  status.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("bobTasks.startWorker", () => startWorker()),
    vscode.commands.registerCommand("bobTasks.stopWorker", () => stopWorker()),
    vscode.commands.registerCommand("bobTasks.toggleWorker", () =>
      worker ? stopWorker() : startWorker(),
    ),
  );

  if (cfg().get<boolean>("autoStart")) startWorker();
}

export function deactivate(): void {
  stopWorker();
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("bobTasks");
}

function projectRoot(): string | undefined {
  const set = cfg().get<string>("projectRoot");
  if (set && set.trim()) return set.trim();
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function setStatus(state: "stopped" | "running" | "deferred" | "idle", detail = ""): void {
  const icon =
    state === "running" ? "$(rocket)" :
    state === "deferred" ? "$(debug-pause)" :
    state === "idle" ? "$(watch)" : "$(circle-slash)";
  status.text = `${icon} Bob Tasks: ${state}${detail ? ` ${detail}` : ""}`;
  status.tooltip = worker ? "Click to stop the Bob Tasks worker" : "Click to start the Bob Tasks worker";
}

function startWorker(): void {
  if (worker || starting) {
    vscode.window.showInformationMessage("Bob Tasks worker is already running.");
    return;
  }
  const root = projectRoot();
  if (!root) {
    vscode.window.showErrorMessage("Bob Tasks: set 'bobTasks.projectRoot' or open the connector folder.");
    return;
  }
  const c = cfg();
  const workerJs = path.join(root, "dist", "worker.js");
  const args = [
    workerJs,
    "--emit-json",
    "--no-notify", // extension shows native notifications instead
    "--max-risk", c.get<string>("maxRisk") ?? "standard",
    "--poll", String(c.get<number>("pollMs") ?? 3000),
    "--timeout", String(c.get<number>("timeoutMs") ?? 300000),
    "--assignee", c.get<string>("assignee") ?? "bob",
    "--pipe", c.get<string>("pipe") ?? "\\\\.\\pipe\\pipe\\bob-ipc",
    "--surface", c.get<string>("dispatch.surface") ?? "sidebar",
    "--defer-idle", String(c.get<number>("deferIdleMs") ?? 60000),
  ];
  if (!c.get<boolean>("deferWhileChatting")) args.push("--no-defer");
  const tag = c.get<string>("tag");
  if (tag && tag.trim()) args.push("--tag", tag.trim());

  const env = { ...process.env };
  const dbPath = c.get<string>("dbPath");
  if (dbPath && dbPath.trim()) env.BOB_TASKS_DB = dbPath.trim();

  const node = c.get<string>("nodePath") || "node";
  out.appendLine(`[start] ${node} ${args.join(" ")}`);
  starting = true;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(node, args, { cwd: root, env });
  } catch (err) {
    // Sync spawn failures only (e.g. bad cwd). ENOENT for a missing `node`
    // arrives async via the 'error' event below.
    starting = false;
    vscode.window.showErrorMessage(`Bob Tasks: failed to start worker — ${(err as Error).message}`);
    return;
  }
  worker = child;
  starting = false;

  // Each handler captures its own `child`, so a late exit/error from a previous
  // worker can't clobber a newer one (the `worker === child` guard).
  const finalize = (label: string): void => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (worker === child) {
      worker = null;
      setStatus("stopped");
    }
    out.appendLine(label);
  };

  let buf = "";
  const decoder = new StringDecoder("utf8"); // stateful, never splits multi-byte chars
  const consume = (line: string) => {
    const t = line.trim(); // also trims trailing \r so CRLF can't break @@WORKER matching
    if (t.startsWith("@@WORKER ")) handleEvent(t.slice(9));
    else if (t) out.appendLine(t);
  };
  child.stdout.on("data", (d: Buffer) => {
    buf += decoder.write(d);
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      consume(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  const errDecoder = new StringDecoder("utf8");
  child.stderr.on("data", (d: Buffer) => out.append(errDecoder.write(d)));
  child.on("error", (err) => {
    // Async spawn failure (e.g. `node` not on PATH), else status sticks on "running".
    vscode.window.showErrorMessage(`Bob Tasks: worker failed — ${err.message}`);
    finalize(`[error] ${err.message}`);
  });
  child.on("exit", (code) => {
    buf += decoder.end(); // flush bytes held back mid multi-byte sequence
    if (buf.trim()) consume(buf); // flush a final line lacking a trailing newline
    buf = "";
    finalize(`[exit] worker exited (code ${code})`);
  });

  // Watchdog: if the worker never reports `connected` (Bob down, IPC wedged,
  // DB locked), don't sit on a false "running"; kill it and tell the user.
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (worker !== child) return;
    out.appendLine(`[start] no 'connected' within ${CONNECT_TIMEOUT_MS}ms — stopping worker`);
    vscode.window.showErrorMessage("Bob Tasks: worker did not connect to Bob — is Bob running?");
    stopWorker();
  }, CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();

  setStatus("running");
  vscode.window.showInformationMessage("Bob Tasks worker started.");
}

function stopWorker(): void {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  starting = false;
  if (!worker) return;
  out.appendLine("[stop] terminating worker");
  // Leave `worker = null` to the exit handler so a quick stop->start can't race
  // it; here just clear the watchdog and reflect intent in the UI.
  worker.kill();
  setStatus("stopped");
}

function handleEvent(json: string): void {
  let ev: any;
  try {
    ev = JSON.parse(json);
  } catch {
    return;
  }
  switch (ev.type) {
    case "connected":
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      setStatus("running");
      break;
    case "taskStart":
      setStatus("running", `#${ev.id} {${ev.mode}}`);
      if (cfg().get<boolean>("dispatch.bringToFront")) {
        // Running inside Bob, so we can re-focus the sidebar on demand (opt-in,
        // default off). Swallow rejection if the command isn't available.
        Promise.resolve(vscode.commands.executeCommand("bob-code.SidebarProvider.focus")).then(
          undefined,
          () => undefined,
        );
      }
      break;
    case "taskDone":
      setStatus("running");
      if (cfg().get<boolean>("notify.enabled")) {
        vscode.window.showInformationMessage(`Bob finished #${ev.id}: ${ev.title}`);
      }
      break;
    case "taskFail":
      setStatus("running");
      if (cfg().get<boolean>("notify.enabled")) {
        vscode.window.showWarningMessage(`Bob task #${ev.id} ${ev.status}.`);
      }
      break;
    case "deferred":
      setStatus("deferred", "(chat active)");
      break;
    case "resumed":
      setStatus("running");
      break;
    case "idle":
      setStatus("idle", ev.gated ? `(${ev.gated} gated)` : "");
      break;
    case "stopped":
      setStatus("stopped");
      break;
    case "error":
      setStatus("stopped");
      if (cfg().get<boolean>("notify.enabled")) {
        vscode.window.showErrorMessage(`Bob Tasks worker error: ${ev.message ?? "unknown"}`);
      }
      break;
  }
}
