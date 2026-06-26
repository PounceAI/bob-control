import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import { pathToFileURL } from "url";
import * as path from "path";
import * as fs from "fs";

/**
 * Bob Tasks extension. Two transports, auto-detected:
 *   - Bob 2.0 (in-process): the node-ipc pipe is gone, so the board-pull loop runs HERE in the extension
 *     host (the only place that can reach `getExtension('IBM.bob-code').exports.startTask`). We import the
 *     connector's compiled driver-loop + in-process driver and run them in-process.
 *   - Bob 1.x (child process): spawn dist/worker.js (real Node >=22.5 for node:sqlite) which dispatches
 *     over the IPC pipe, wired to this UI via its @@WORKER {json} stdout stream.
 * Either way: settings map to worker options, native notifications, optional bring-to-front, start/stop
 * commands, and a status-bar item.
 */

let worker: ChildProcessWithoutNullStreams | null = null;
let starting = false; // set between spawn() and child going live; blocks double-start
let connected = false; // true once the worker reports `connected`; reset on each start
let connectTimer: ReturnType<typeof setTimeout> | null = null; // startup watchdog
// Bob 2.0 in-process loop handle (mutually exclusive with `worker`): stop() signals it to finish.
let loop: { stop: () => void } | null = null;
let status: vscode.StatusBarItem;
let out: vscode.OutputChannel;
let memento: vscode.Memento | null = null; // globalState, for the one-time auto-approve notice

const CONNECT_TIMEOUT_MS = 30_000;
// globalState key: have we shown the "auto-approve is a global, persistent change" notice yet?
const AUTO_APPROVE_NOTICE_KEY = "bobTasks.autoApproveNoticeShown";

export function activate(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  out = vscode.window.createOutputChannel("Bob Tasks");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "bobTasks.toggleWorker";
  context.subscriptions.push(out, status);
  setStatus("stopped");
  status.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("bobTasks.startWorker", () => startWorker()),
    vscode.commands.registerCommand("bobTasks.stopWorker", () => stopWorker()),
    vscode.commands.registerCommand("bobTasks.toggleWorker", () => toggleWorker()),
    // URI handler so a process outside Bob (e.g. Claude Code in WSL) can drive the
    // worker without a VS Code command, via the editor's URL protocol:
    //   code.exe --open-url "<scheme>://local.bob-tasks/start"   (also /stop, /toggle)
    // The extension is then the single owner of the worker, so its status bar
    // reflects every dispatch and there's no two-worker contention on Bob's pipe.
    vscode.window.registerUriHandler({ handleUri }),
  );

  if (cfg().get<boolean>("autoStart")) startWorker();
}

export function deactivate(): void {
  stopWorker();
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("bobTasks");
}

/**
 * Working directory the worker runs in — the project Bob operates on. The board DB
 * is anchored to the connector install (db.ts resolves it from the module dir, not
 * cwd), so this only steers where verify/judge run `git`. Defaults to the open
 * workspace folder, so those checks act on whatever project you have open in Bob.
 */
function projectRoot(): string | undefined {
  const set = cfg().get<string>("projectRoot");
  if (set && set.trim()) return set.trim();
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Locate the connector install that holds dist/worker.js. Independent of the open
 * folder, so the worker can run while Bob has ANY project open — not just the
 * connector repo. Resolution order:
 *   1. bobTasks.connectorPath        — explicit install path wins.
 *   2. any open workspace folder      — covers having the connector repo open.
 *      that contains dist/worker.js
 *   3. legacy bobTasks.projectRoot    — back-compat: it used to double as the install
 *      (if it still holds worker.js)    path before connectorPath existed.
 * Returns undefined if none has dist/worker.js, so the caller can give a clear error.
 */
function connectorRoot(): string | undefined {
  const hasWorker = (dir: string): boolean => {
    try {
      return fs.existsSync(path.join(dir, "dist", "worker.js"));
    } catch {
      return false;
    }
  };
  const explicit = cfg().get<string>("connectorPath");
  if (explicit && explicit.trim()) return explicit.trim(); // honored even if missing, so the error names it
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (hasWorker(f.uri.fsPath)) return f.uri.fsPath;
  }
  const legacy = cfg().get<string>("projectRoot");
  if (legacy && legacy.trim() && hasWorker(legacy.trim())) return legacy.trim();
  return undefined;
}

function setStatus(state: "stopped" | "running" | "deferred" | "idle", detail = ""): void {
  const icon =
    state === "running" ? "$(rocket)" :
    state === "deferred" ? "$(debug-pause)" :
    state === "idle" ? "$(watch)" : "$(circle-slash)";
  status.text = `${icon} Bob Tasks: ${state}${detail ? ` ${detail}` : ""}`;
  status.tooltip = worker || loop ? "Click to stop the Bob Tasks worker" : "Click to start the Bob Tasks worker";
}

function startWorker(force = false): void {
  if (worker || starting || loop) {
    vscode.window.showInformationMessage("Bob Tasks worker is already running.");
    return;
  }
  const connector = connectorRoot();
  if (!connector) {
    vscode.window.showErrorMessage(
      "Bob Tasks: can't find dist/worker.js. Set 'bobTasks.connectorPath' to the Bob Control " +
        "connector folder (the one containing dist/worker.js), or open that folder in this window.",
    );
    return;
  }
  // Detect the transport (Bob 2.0 in-process vs 1.x IPC child) — async because the 2.0 driver lives in
  // the connector's compiled dist, dynamically imported. Block double-starts during detection.
  starting = true;
  void detectAndStart(connector, force).catch((err) => {
    starting = false;
    setStatus("stopped");
    out.appendLine(`[start] detection failed: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Bob Tasks: failed to start — ${(err as Error).message}`);
  });
}

/**
 * Resolve which Bob this window is and start the matching transport: the in-process loop when Bob 2.0's
 * exports are reachable, else the 1.x IPC child. The 2.0 path needs no ROO_CODE_IPC_SOCKET_PATH (no pipe).
 */
async function detectAndStart(connector: string, force: boolean): Promise<void> {
  // bob-code's exports are only populated once it has activated. At autostart it may not have yet, which
  // would misdetect a 2.0 window as 1.x — so activate it first (no-op if absent or already active).
  const bobExt = vscode.extensions.getExtension("IBM.bob-code");
  if (bobExt && !bobExt.isActive) {
    try {
      await bobExt.activate();
    } catch {
      /* fall through — isBob2Window will be false and we take the 1.x path */
    }
  }
  const mods = await loadConnector(connector);
  const host = mods.createBob2Host({
    getExtension: (id: string) => vscode.extensions.getExtension(id),
    workspaceFolders: () => vscode.workspace.workspaceFolders,
  });
  if (mods.isBob2Window(host)) {
    out.appendLine("[start] Bob 2.0 detected — running the board loop in-process (no IPC child).");
    startInProcessLoop(connector, mods, host);
    return;
  }
  // Bob 1.x: the worker connects over the IPC pipe, which launch-bob-ipc.cmd opens via
  // ROO_CODE_IPC_SOCKET_PATH. An absent var means Bob was started the wrong way; warn rather than burn
  // the 30s connect watchdog. `force` is the "Start anyway" bypass.
  starting = false;
  if (!force && !process.env.ROO_CODE_IPC_SOCKET_PATH) {
    warnLaunchEnvironment();
    return;
  }
  spawnWorker(connector);
}

function spawnWorker(connector: string): void {
  if (worker || starting || loop) return; // re-entrancy guard (detection already passed)
  const c = cfg();
  const workerJs = path.join(connector, "dist", "worker.js");
  if (!fs.existsSync(workerJs)) {
    vscode.window.showErrorMessage(
      `Bob Tasks: no worker at ${workerJs}. Check 'bobTasks.connectorPath' and run 'npm run build' in the connector.`,
    );
    return;
  }
  // The worker runs in the project Bob has open (verify/judge git operations target
  // it); the board DB stays with the connector regardless. Fall back to the connector
  // when no folder is open so cwd is always a real directory spawn() can use.
  const cwd = projectRoot() ?? connector;
  const args = [
    workerJs,
    "--emit-json",
    "--no-notify", // extension shows native notifications instead
    "--max-risk", c.get<string>("maxRisk") ?? "standard",
    "--poll", String(c.get<number>("pollMs") ?? 3000),
    "--timeout", String(c.get<number>("timeoutMs") ?? 300000),
    "--assignee", c.get<string>("assignee") ?? "bob",
    // Default to this host Bob's own socket so the worker targets the instance it runs in, not
    // whichever Bob owns the shared global pipe; an explicit bobTasks.pipe still overrides.
    "--pipe", c.get<string>("pipe") || process.env.ROO_CODE_IPC_SOCKET_PATH || "\\\\.\\pipe\\pipe\\bob-ipc",
    "--surface", c.get<string>("dispatch.surface") ?? "sidebar",
    "--defer-idle", String(c.get<number>("deferIdleMs") ?? 60000),
  ];
  if (c.get<boolean>("deferWhileChatting") === false) args.push("--no-defer"); // only when EXPLICITLY off
  const tag = c.get<string>("tag");
  if (tag && tag.trim()) args.push("--tag", tag.trim());
  // Reversible toggles. The command classifier (approve/deny gray-zone commands,
  // needs the Bob button patch), the followup answerer (answer Bob's questions),
  // and the LLM judge (verify task completion) are independent but share one Claude
  // backend, so push the backend config when any is on. Off by default = manual
  // approval / questions wait for you / no judge.
  const wantClassifier = c.get<boolean>("commandClassifier");
  const wantFollowups = c.get<boolean>("answerFollowups");
  const verifyAndContinue = c.get<boolean>("verifyAndContinue");
  const wantJudge = verifyAndContinue && c.get<boolean>("verifyJudge");
  if (wantClassifier) args.push("--command-classifier");
  if (wantFollowups) args.push("--answer-followups");
  if (c.get<boolean>("escalateAll")) args.push("--escalate-all");
  if (c.get<boolean>("reviewPlans")) args.push("--review-plans");
  if (wantClassifier || wantFollowups || wantJudge) {
    args.push("--classifier-backend", c.get<string>("classifierBackend") ?? "cli");
    const model = c.get<string>("classifierModel");
    if (model && model.trim()) args.push("--classifier-model", model.trim());
    const cliPath = c.get<string>("classifierCliPath");
    if (cliPath && cliPath.trim()) args.push("--classifier-cli", cliPath.trim());
  }
  // Verify-and-continue: loop back to Bob to fix issues until acceptance check passes
  if (verifyAndContinue) {
    args.push("--verify-and-continue");
    const verifyCmd = c.get<string>("verifyCommand");
    if (verifyCmd && verifyCmd.trim()) args.push("--verify-command", verifyCmd.trim());
    if (c.get<boolean>("verifyJudge")) args.push("--verify-judge");
    args.push("--max-continues", String(c.get<number>("maxContinues") ?? 3));
  }
  // Detect plan-only completions (no code written) and auto-continue
  if (c.get<boolean>("detectPlanStop")) args.push("--detect-plan-stop");
  // Auto-retry transient failures (timeout/abort)
  const maxRetryAttempts = c.get<number>("maxRetryAttempts") ?? 0;
  if (maxRetryAttempts > 0) args.push("--retry", String(maxRetryAttempts));
  // Extend the safe command allowlist for advanced mode
  const allowCommands = c.get<string>("allowCommands");
  if (allowCommands && allowCommands.trim()) args.push("--allow-commands", allowCommands.trim());

  const env = { ...process.env };
  // Board selection, in precedence: explicit bobTasks.dbPath > worktree-shared > per-project. Per-project
  // (default) gives each project its own queue (matching the plugin MCP's ${CLAUDE_PROJECT_DIR} board);
  // without it the worker falls back to db.ts's module-relative default = the connector's board.
  const dbPath = c.get<string>("dbPath");
  // Honor an INHERITED BOB_TASKS_WORKTREE_SHARED too, not just the setting: the env var is the one opt-in
  // every consumer (plugin MCP, statusline, CLI) reads, so the worker must agree or it'd drain a different
  // board than the plugin fills. If we pinned BOB_TASKS_DB below, it would (rule 1) override that flag.
  const worktreeShared = c.get<boolean>("worktreeShared") || !!process.env.BOB_TASKS_WORKTREE_SHARED;
  if (dbPath && dbPath.trim()) {
    env.BOB_TASKS_DB = dbPath.trim();
  } else if (worktreeShared) {
    // Every linked worktree drains the MAIN worktree's queue. Don't pin BOB_TASKS_DB (it would override
    // the resolver). Pin CLAUDE_PROJECT_DIR to THIS worktree (cwd) so the resolver's base is deterministic
    // — a stale CLAUDE_PROJECT_DIR inherited from the host process must not redirect it to another tree.
    env.BOB_TASKS_WORKTREE_SHARED = "1";
    env.CLAUDE_PROJECT_DIR = cwd;
    delete env.BOB_TASKS_DB; // drop any inherited pin so the resolver runs
  } else {
    env.BOB_TASKS_DB = path.join(cwd, "data", "tasks.db");
  }

  const node = c.get<string>("nodePath") || "node";
  out.appendLine(`[start] (cwd ${cwd}) ${node} ${args.join(" ")}`);
  starting = true;
  connected = false; // not yet acknowledged by Bob; the exit handler reads this
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(node, args, { cwd, env });
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
    // A worker that dies BEFORE it ever connected (nonzero exit) looks like the
    // status bar "turning itself off" with no reason. The fast-path connect failure
    // (worker.js missing, Bob not exposing IPC on this window) beats the 30s watchdog
    // to the punch, so say why here instead of leaving a silent flip to "stopped".
    const diedUnconnected = !connected && code !== 0 && code !== null;
    finalize(`[exit] worker exited (code ${code})`);
    if (diedUnconnected) {
      vscode.window.showErrorMessage(
        `Bob Tasks: worker stopped before connecting (exit ${code}). Is Bob running with IPC on ` +
          `THIS window, and is 'bobTasks.connectorPath' correct? See the "Bob Tasks" output for details.`,
      );
    }
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

/** The connector exports the in-process loop needs — dynamically imported from the install's compiled
 *  dist (ESM), since the connector path is configurable and not bundled into the extension. */
interface ConnectorModules {
  createBob2Host: (deps: {
    getExtension: (id: string) => unknown;
    workspaceFolders: () => readonly { uri: { fsPath: string } }[] | undefined;
  }) => unknown;
  isBob2Window: (host: unknown) => boolean;
  InProcessDriver: new (host: unknown, opts?: unknown) => unknown;
  runDriverLoop: (cfg: unknown, shouldStop?: () => boolean) => Promise<void>;
  parseOpts: (argv: string[]) => unknown;
  /** Writes Bob's headless auto-approve into global settings.json; we inject a gated wrapper (the setting +
   *  one-time notice live in the extension, keeping the driver vscode-free). Returns the path written. */
  writeAutoApprove: (path?: string) => { path: string; created: boolean };
}

async function loadConnector(connector: string): Promise<ConnectorModules> {
  // import() (not require) so Node loads the connector's ESM dist from a CJS extension; Node16 module
  // mode preserves the dynamic import. file:// URL so Windows paths resolve.
  const load = (f: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(path.join(connector, "dist", f)).href) as Promise<Record<string, unknown>>;
  const [host, driver, loopMod, workerMod, configMod] = await Promise.all([
    load("bob2-host.js"),
    load("bob2-driver.js"),
    load("driver-loop.js"),
    load("worker.js"),
    load("bob2-config.js"),
  ]);
  return {
    createBob2Host: host.createBob2Host as ConnectorModules["createBob2Host"],
    isBob2Window: driver.isBob2Window as ConnectorModules["isBob2Window"],
    InProcessDriver: driver.InProcessDriver as ConnectorModules["InProcessDriver"],
    runDriverLoop: loopMod.runDriverLoop as ConnectorModules["runDriverLoop"],
    parseOpts: workerMod.parseOpts as ConnectorModules["parseOpts"],
    writeAutoApprove: configMod.writeAutoApprove as ConnectorModules["writeAutoApprove"],
  };
}

/**
 * The auto-approve write the driver runs on connect(), gated + surfaced per Bob's design review (option e):
 * the `bobTasks.autoApproveGlobal` setting can turn it off (Bob then prompts), and the FIRST write shows a
 * one-time notice — because it's a user-global, persistent change that disables Bob's command security
 * across every window/project. Injected via the driver's `writeApproval` seam so the driver stays vscode-free.
 */
function makeWriteApproval(writeAutoApprove: ConnectorModules["writeAutoApprove"]): () => void {
  return () => {
    if (cfg().get<boolean>("autoApproveGlobal") === false) {
      out.appendLine("[approve] autoApproveGlobal is off — skipping the global auto-approve write (Bob will prompt).");
      return;
    }
    const { path: written } = writeAutoApprove();
    out.appendLine(`[approve] wrote headless auto-approve to ${written}`);
    if (memento && !memento.get<boolean>(AUTO_APPROVE_NOTICE_KEY)) {
      void memento.update(AUTO_APPROVE_NOTICE_KEY, true);
      void vscode.window
        .showInformationMessage(
          `Bob Tasks enabled headless auto-approve in ${written} — this disables Bob's command security ` +
            `globally (every window/project) so queued tasks run unattended. Turn it off with the ` +
            `'bobTasks.autoApproveGlobal' setting.`,
          "Open Setting",
        )
        .then((pick) => {
          if (pick === "Open Setting")
            void vscode.commands.executeCommand("workbench.action.openSettings", "bobTasks.autoApproveGlobal");
        });
    }
  };
}

/**
 * Point the connector's board resolver at the right DB by setting the same env vars the 1.x child got —
 * but on THIS process, since the loop runs in-process. Precedence: explicit dbPath > worktree-shared
 * (drain the main worktree's board) > per-project data/tasks.db. Matches the spawn path's env logic.
 */
function applyBoardEnv(cwd: string): void {
  const c = cfg();
  const dbPath = c.get<string>("dbPath");
  const worktreeShared = c.get<boolean>("worktreeShared") || !!process.env.BOB_TASKS_WORKTREE_SHARED;
  if (dbPath && dbPath.trim()) {
    process.env.BOB_TASKS_DB = dbPath.trim();
  } else if (worktreeShared) {
    process.env.BOB_TASKS_WORKTREE_SHARED = "1";
    process.env.CLAUDE_PROJECT_DIR = cwd;
    delete process.env.BOB_TASKS_DB; // let the resolver run; a stale pin must not redirect the board
  } else {
    process.env.BOB_TASKS_DB = path.join(cwd, "data", "tasks.db");
  }
}

/**
 * Start the Bob 2.0 board loop IN this extension host. No child process, no pipe: the loop calls
 * exports.startTask and watches ~/.bob/db/bob.db. The genuinely IPC-bound 1.x flags (classifier/followups/
 * pipe/surface) don't apply — 2.0 auto-approves via config (V4) and exposes no reply channel. Defer-while-
 * chatting DOES apply, re-derived from a bob.db poll.
 */
function startInProcessLoop(connector: string, mods: ConnectorModules, host: unknown): void {
  const c = cfg();
  const cwd = projectRoot() ?? connector; // git evidence / checkpoint run here (the open project)
  applyBoardEnv(cwd);
  const args = [
    "--max-risk", c.get<string>("maxRisk") ?? "standard",
    "--poll", String(c.get<number>("pollMs") ?? 3000),
    "--timeout", String(c.get<number>("timeoutMs") ?? 300000),
    "--assignee", c.get<string>("assignee") ?? "bob",
  ];
  const tag = c.get<string>("tag");
  if (tag && tag.trim()) args.push("--tag", tag.trim());
  // Defer-while-chatting: ported to 2.0 via a bob.db poll (driver.externalActivity), so the loop pauses
  // dispatch while you're mid-chat in this window's Bob. Same flags as the 1.x worker; --defer-stale is
  // 1.x-only (event-pairing self-heal) — bob.db status is ground truth, so the 2.0 path needs no stale guard.
  args.push("--defer-idle", String(c.get<number>("deferIdleMs") ?? 60000));
  if (c.get<boolean>("deferWhileChatting") === false) args.push("--no-defer"); // only when EXPLICITLY off
  const maxRetry = c.get<number>("maxRetryAttempts") ?? 0;
  if (maxRetry > 0) args.push("--retry", String(maxRetry));
  // Verify-and-continue: command-verify, plan-stop, AND the LLM judge are ported to the in-process loop.
  const verifyAndContinue = c.get<boolean>("verifyAndContinue");
  const wantJudge = verifyAndContinue && c.get<boolean>("verifyJudge");
  if (verifyAndContinue) {
    args.push("--verify-and-continue");
    const verifyCmd = c.get<string>("verifyCommand");
    if (verifyCmd && verifyCmd.trim()) args.push("--verify-command", verifyCmd.trim());
    args.push("--max-continues", String(c.get<number>("maxContinues") ?? 3));
    if (wantJudge) args.push("--verify-judge");
  }
  if (c.get<boolean>("detectPlanStop")) args.push("--detect-plan-stop");
  // The judge needs a Claude backend (cli default, or api with ANTHROPIC_API_KEY in the host env).
  if (wantJudge) {
    args.push("--classifier-backend", c.get<string>("classifierBackend") ?? "cli");
    const model = c.get<string>("classifierModel");
    if (model && model.trim()) args.push("--classifier-model", model.trim());
    const cliPath = c.get<string>("classifierCliPath");
    if (cliPath && cliPath.trim()) args.push("--classifier-cli", cliPath.trim());
  }
  const opts = mods.parseOpts(args);
  const driver = new mods.InProcessDriver(host, { writeApproval: makeWriteApproval(mods.writeAutoApprove) });

  let stopped = false;
  loop = { stop: () => void (stopped = true) };
  starting = false;
  connected = false;
  setStatus("running");
  out.appendLine(`[start] (cwd ${cwd}) in-process 2.0 loop — ${args.join(" ")}`);

  void mods
    .runDriverLoop(
      {
        driver,
        opts,
        cwd,
        log: (m: string) => out.appendLine(m),
        emit: (type: string, data: Record<string, unknown>) => handleEventObj({ type, ...data }),
      },
      () => stopped,
    )
    .then(
      () => {
        loop = null;
        setStatus("stopped");
        out.appendLine("[exit] in-process loop ended");
      },
      (err: unknown) => {
        loop = null;
        setStatus("stopped");
        const msg = (err as Error).message;
        out.appendLine(`[error] in-process loop: ${msg}`);
        vscode.window.showErrorMessage(`Bob Tasks loop error: ${msg}`);
      },
    );
}

/**
 * Warn that Bob was started without launch-bob-ipc.cmd, and offer a fix or a one-shot bypass.
 * Fires only on an actual start attempt — no persisted suppression that could later hide a
 * real failure; "Start anyway" re-enters startWorker with force.
 */
function warnLaunchEnvironment(): void {
  const FIX = "How to fix";
  const ANYWAY = "Start anyway";
  void vscode.window
    .showWarningMessage(
      "Bob Tasks: IBM Bob was started without launch-bob-ipc.cmd, so the IPC pipe isn't open " +
        "(the worker can't connect) and auto-approval isn't applied (commands stall on manual " +
        "prompts). Fully quit Bob and relaunch via launch-bob-ipc.cmd — or start the worker anyway.",
      FIX,
      ANYWAY,
    )
    .then((choice) => {
      if (choice === FIX) {
        out.appendLine(
          "[self-check] To fix: fully quit IBM Bob, then start it from launch-bob-ipc.cmd in the " +
            "connector folder — it sets ROO_CODE_IPC_SOCKET_PATH and runs set-bob-autoapprove.mjs " +
            "(which must happen while Bob is closed). Repoint your taskbar/Start shortcut at " +
            "launch-bob-ipc.cmd so it can't be bypassed.",
        );
        out.show(true);
      } else if (choice === ANYWAY) {
        startWorker(true);
      }
    });
}

function stopWorker(): void {
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  starting = false;
  // Bob 2.0 in-process loop: signal it to stop. It finishes the current dispatch (if any) then resolves,
  // which nulls `loop`. Reflect intent in the UI now.
  if (loop) {
    out.appendLine("[stop] stopping in-process loop");
    loop.stop();
    setStatus("stopped");
    return;
  }
  if (!worker) return;
  out.appendLine("[stop] terminating worker");
  // Leave `worker = null` to the exit handler so a quick stop->start can't race
  // it; here just clear the watchdog and reflect intent in the UI.
  worker.kill();
  setStatus("stopped");
}

function toggleWorker(): void {
  if (worker || loop) stopWorker();
  else startWorker();
}

/**
 * Handle an external URL dispatched to the extension (vscode.window.registerUriHandler).
 * The path selects the action: /start | /stop | /toggle. Lets a WSL-side process
 * trigger the worker that a VS Code command would otherwise be needed for.
 */
function handleUri(uri: vscode.Uri): void {
  const action = uri.path.replace(/^\/+/, "").toLowerCase();
  out.appendLine(`[uri] ${uri.toString()} → ${action || "(none)"}`);
  switch (action) {
    case "start":
      startWorker();
      break;
    case "stop":
      stopWorker();
      break;
    case "toggle":
      toggleWorker();
      break;
    default:
      vscode.window.showWarningMessage(
        `Bob Tasks: unknown URI action '${action}'. Use /start, /stop, or /toggle.`,
      );
  }
}

function handleEvent(json: string): void {
  let ev: any;
  try {
    ev = JSON.parse(json);
  } catch {
    return;
  }
  handleEventObj(ev);
}

/** The parsed-event handler, shared by the 1.x child's @@WORKER stream and the 2.0 in-process loop's
 *  emit(). Both speak the same event vocabulary (connected/taskStart/taskDone/taskFail/idle/stopped/error). */
function handleEventObj(ev: any): void {
  switch (ev.type) {
    case "connected":
      connected = true; // the exit handler uses this to tell a clean stop from a failed start
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
    case "question":
      handleEscalatedQuestion(ev);
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

/**
 * Handle an escalated followup question from the worker. Show an input box
 * for the human to answer, then write the answer to the worker's stdin.
 */
function handleEscalatedQuestion(ev: { id: number; title: string; question: string; options?: string[] }): void {
  const { id, title, question, options } = ev;
  const short = question.replace(/\s+/g, " ").slice(0, 100);
  out.appendLine(`[question] task #${id}: ${short}`);

  // Show a toast notification
  if (cfg().get<boolean>("notify.enabled")) {
    vscode.window.showInformationMessage(`Bob needs an answer on #${id}: ${title}`);
  }

  // Show an input box with the question and optional suggestions
  const prompt = `Task #${id}: ${question}`;
  const placeHolder = options && options.length > 0
    ? `Suggestions: ${options.join(", ")}`
    : "Type your answer";

  vscode.window.showInputBox({
    prompt,
    placeHolder,
    ignoreFocusOut: true, // Don't dismiss if user switches windows
  }).then((answer) => {
    if (answer === undefined) {
      // User cancelled (ESC or closed the input box)
      out.appendLine(`[question] task #${id}: user cancelled answer`);
      return;
    }

    if (!answer.trim()) {
      vscode.window.showWarningMessage("Answer cannot be empty.");
      return;
    }

    // Send the answer to the worker via stdin
    if (worker) {
      const answerLine = `@@ANSWER ${JSON.stringify({ taskId: id, answer: answer.trim() })}\n`;
      worker.stdin.write(answerLine);
      out.appendLine(`[question] task #${id}: sent answer → ${answer.trim().slice(0, 60)}`);
    } else {
      out.appendLine(`[question] task #${id}: worker not running, cannot send answer`);
    }
  });
}
