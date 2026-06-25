import type { BobDriver } from "./bob-driver.js";
import type { DispatchCore, DispatchResult } from "./bob-ipc.js";
import { Bob2TaskStore, awaitTurnSettled, type Bob2TaskRow } from "./bob2-taskstore.js";
import { writeAutoApprove } from "./bob2-config.js";

// V5: the Bob 2.0 in-process driver. Bob 2.0 removed the node-ipc pipe, so the only way to start a task
// is the extension's exported activate() API (`getExtension('IBM.bob-code').exports.startTask`), callable
// only from a sibling extension in the same window. startTask resolves on DISPATCH, returns no id, and
// emits no event stream — so completion is observed by correlating OUR task's row in ~/.bob/db/bob.db
// (V3) and polling its status, and auto-approve is pre-written to settings.json (V4), not pressed.
//
// Everything Bob-host-specific is behind the Bob2Host seam, so the driver is unit-testable with a fake
// host + synthetic db. The thin production binding (the real `vscode.extensions.getExtension` /
// `vscode.workspace`) and the live-2.0 behaviors (does bob.db materialize? does the dir string match?)
// are the V5 tail / V7 gate — see docs/bob-2-inprocess.md. UNVERIFIED against a live Bob 2.0.

/**
 * The slice of Bob 2.0's exported activate() API the driver needs. The full surface
 * (openNewTask/startWorkflow/setChatContent/registerSource/setFindings) is unused at MVP.
 * `startTask` resolves on dispatch (not completion) and returns no task id.
 */
export interface Bob2StartTask {
  startTask(opts: { content: string; mode?: string; workspaceFolder?: string }): Promise<unknown> | unknown;
}

/**
 * Host seam: resolves Bob 2.0's exports and the open workspace folder, so the driver carries no direct
 * `vscode` dependency and tests inject a fake. The production impl (V5 tail) calls
 * `vscode.extensions.getExtension('IBM.bob-code')?.exports` and reads `vscode.workspace.workspaceFolders`.
 */
export interface Bob2Host {
  /** Bob 2.0's extension exports, or null when the extension isn't present/activated (⇒ not a 2.x window). */
  exports(): Bob2StartTask | null;
  /** fsPath of the workspace folder Bob has open, or null when unknowable. */
  workspaceFolder(): string | null;
}

export interface InProcessDriverOptions {
  /** Open the task store. Default: the live `~/.bob/db/bob.db` (read-only). Tests inject a synthetic db. */
  openStore?: () => Bob2TaskStore;
  /** Apply the 2.0 auto-approve config once on connect. Default: V4 `writeAutoApprove` to settings.json. */
  writeApproval?: () => void;
  /** Completion-watch poll cadence (ms). */
  pollMs?: number;
  /** How long to wait for our new task row to materialize after startTask returns no id (ms). */
  correlateTimeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Map a settled task-store row to a DispatchResult. `settled:false` means the wall-clock elapsed while
 * the turn was still running ⇒ timeout. Otherwise the terminal status decides: `completed` → completed,
 * `error` → aborted; anything else after the turn ran (the row went back to `active`/`paused` without
 * completing, or the row vanished) → idle, the closest 1.x analog the worker already handles. No result
 * text or token usage on 2.0's documented columns — result-text capture and `costs` budget are deferred
 * (V6); see docs/bob-2-inprocess.md.
 */
export function mapOutcome(row: Bob2TaskRow | null, settled: boolean): DispatchResult {
  const base = { taskId: row ? String(row.id) : null, result: "", lastText: "", tokensUsed: 0, turns: 0 };
  if (!settled) return { ...base, status: "timeout" };
  if (row?.status === "completed") return { ...base, status: "completed" };
  if (row?.status === "error") return { ...base, status: "aborted" };
  return { ...base, status: "idle" };
}

export class InProcessDriver implements BobDriver {
  private handle: Bob2StartTask | null = null;
  private approvalWritten = false;
  private readonly pollMs: number;
  private readonly correlateTimeoutMs: number;

  constructor(
    private readonly host: Bob2Host,
    private readonly opts: InProcessDriverOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.correlateTimeoutMs = opts.correlateTimeoutMs ?? 15_000;
  }

  /** Resolve the in-process handle and apply auto-approve once. Throws when startTask isn't reachable
   *  (not a Bob 2.0 window) so the caller can fall back to the IPC driver. Re-callable (idempotent). */
  async connect(): Promise<void> {
    const ex = this.host.exports();
    if (!ex || typeof ex.startTask !== "function") {
      throw new Error(
        "Bob 2.0 in-process driver: IBM.bob-code exports.startTask is not reachable (not a Bob 2.0 window?)",
      );
    }
    this.handle = ex;
    // Auto-approve is config-driven on 2.0 (no per-prompt press to drive headless), so write it once
    // up front; a dispatch with the gate still armed would wedge on the first permission prompt.
    if (!this.approvalWritten) {
      (this.opts.writeApproval ?? (() => void writeAutoApprove()))();
      this.approvalWritten = true;
    }
  }

  /** Native on 2.0: the open folder comes straight from the VS Code API via the host (no IPC handshake). */
  queryWorkspace(): Promise<string | null> {
    return Promise.resolve(this.host.workspaceFolder());
  }

  async dispatch(opts: DispatchCore): Promise<DispatchResult> {
    if (!this.handle) await this.connect();
    const dir = this.host.workspaceFolder();
    if (!dir) throw new Error("Bob 2.0 driver: no open workspace folder to correlate the dispatch against");
    const correlationDir = this.correlationDir(dir);

    // Snapshot the directory's high-water id BEFORE startTask, so the row whose id > baseline is ours.
    // The store may not exist yet on the very first task (Bob creates bob.db lazily) — baseline 0 then,
    // and correlate() waits for the file to appear.
    let store = this.tryOpenStore();
    const baseline = store ? store.maxIdInDir(correlationDir) : 0;
    try {
      await this.handle!.startTask({ content: opts.text, mode: opts.mode ?? undefined, workspaceFolder: dir });
      const correlated = await this.correlate(store, correlationDir, baseline);
      store = correlated.store; // correlate may have opened the store if it didn't exist at baseline time
      if (correlated.id === null) return mapOutcome(null, true); // never appeared ⇒ idle (couldn't correlate)
      const { settled, row } = await awaitTurnSettled(store!, correlated.id, {
        pollMs: this.pollMs,
        timeoutMs: opts.timeoutMs ?? 300_000,
      });
      return mapOutcome(row, settled);
    } finally {
      store?.close();
    }
  }

  /** No persistent watcher between dispatches (the store is opened per-dispatch), so close is a no-op. */
  close(): void {}

  /**
   * The directory string used to correlate our task in bob.db. Verbatim today: we pass `workspaceFolder`
   * to startTask and filter `tasks.directory` by the same value, so it matches IF Bob stores our arg
   * unchanged. The ONE place to normalize once V7 reveals Bob's exact stored form (drive-letter case /
   * separators / trailing slash) — see docs/bob-2-inprocess.md.
   */
  private correlationDir(fsPath: string): string {
    return fsPath;
  }

  private tryOpenStore(): Bob2TaskStore | null {
    try {
      return (this.opts.openStore ?? (() => Bob2TaskStore.open()))();
    } catch {
      return null; // bob.db not created yet (no task has ever run) — correlate() retries until it is
    }
  }

  /**
   * Find our task's row id after startTask (which returns none). Polls `newRootTaskSince` until the new
   * root row appears, opening the store first if it didn't exist at baseline time. Returns id null if
   * nothing materializes within correlateTimeoutMs (the driver maps that to idle).
   */
  private async correlate(
    initial: Bob2TaskStore | null,
    dir: string,
    baseline: number,
  ): Promise<{ store: Bob2TaskStore | null; id: number | null }> {
    let store = initial;
    const deadline = Date.now() + this.correlateTimeoutMs;
    for (;;) {
      if (!store) store = this.tryOpenStore();
      const row = store?.newRootTaskSince(dir, baseline);
      if (row) return { store, id: row.id };
      if (Date.now() >= deadline) return { store, id: null };
      await sleep(this.pollMs);
    }
  }
}

/**
 * Capability detection: is this a Bob 2.0 window? True when the extension exports a callable `startTask`.
 * 2.0 removed the IPC pipe, so a reachable startTask is the positive 2.x signal; its absence means the
 * worker should fall back to the 1.x pipe transport (`BobClient`). The one branch that picks the driver.
 */
export function isBob2Window(host: Bob2Host): boolean {
  const ex = host.exports();
  return !!ex && typeof ex.startTask === "function";
}

/**
 * Pick the driver for the current Bob: the in-process driver on a 2.0 window, else the caller's 1.x IPC
 * driver. `makeIpc` is a thunk so the IPC client (and its pipe resolution) is only constructed on the
 * 1.x path — the 2.0 host has no pipe to connect to.
 */
export function selectDriver(host: Bob2Host, makeIpc: () => BobDriver, opts?: InProcessDriverOptions): BobDriver {
  return isBob2Window(host) ? new InProcessDriver(host, opts) : makeIpc();
}
