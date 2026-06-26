import type { BobDriver } from "./bob-driver.js";
import type { DispatchCore, DispatchResult } from "./bob-ipc.js";
import {
  Bob2TaskStore,
  awaitTurnSettled,
  bob2DbExists,
  parseCosts,
  sleep,
  taskError,
  type Bob2TaskRow,
} from "./bob2-taskstore.js";
import { writeAutoApprove } from "./bob2-config.js";

// V5: the Bob 2.0 in-process driver. Bob 2.0 removed the node-ipc pipe, so the only way to start a task
// is the extension's exported activate() API (`getExtension('IBM.bob-code').exports.startTask`), callable
// only from a sibling extension in the same window. startTask resolves on DISPATCH, returns no id, and
// emits no event stream — so completion is observed by snapshotting Bob's task store (~/.bob/db/bob.db),
// calling startTask, correlating OUR task as the new root row that appears (id is a uuid → order by
// created_at), and polling its status; auto-approve is pre-written to settings.json (V4), not pressed.
//
// Everything Bob-host-specific is behind the Bob2Host seam, so the driver is unit-testable with a fake
// host + synthetic db. The production binding (the real `vscode.extensions.getExtension` / `vscode.
// workspace`) is the V5 tail, and one behavior stays UNVERIFIED until a task is dispatched on a live 2.0:
// the exact `directory` Bob stores (migrated rows show "") — so correlation deliberately does NOT filter
// by directory; it relies on snapshot-diff + sequential dispatch (the busy guard). See docs/bob-2-inprocess.md.

/**
 * The slice of Bob 2.0's exported activate() API the driver needs (fuller surface:
 * openNewTask/startWorkflow/setChatContent/registerSource/setFindings). `startTask` resolves on dispatch,
 * not completion, and returns no task id. `workspaceFolder` must be a real `vscode.WorkspaceFolder` OBJECT
 * — Bob does `useWorkspace.uri.fsPath`, so an fsPath string throws "…reading 'fsPath'" (live 2026-06-25);
 * omit it to let Bob default to its open folder. `mask` is the task's UI label. Opaque (driver stays vscode-free).
 */
export interface Bob2StartTask {
  startTask(opts: {
    content: string;
    mode?: string;
    workspaceFolder?: unknown;
    mask?: string;
  }): Promise<unknown> | unknown;
}

/**
 * Host seam: resolves Bob 2.0's exports and the open workspace folder, so the driver carries no direct
 * `vscode` dependency and tests inject a fake. The production impl (V5 tail) calls
 * `vscode.extensions.getExtension('IBM.bob-code')?.exports` and reads `vscode.workspace.workspaceFolders`.
 */
export interface Bob2Host {
  /** Bob 2.0's extension exports, or null when the extension isn't present/activated (⇒ not a 2.x window). */
  exports(): Bob2StartTask | null;
  /** fsPath of Bob's open folder (dispatch guard, queryWorkspace, logging) — NOT for startTask; null if none. */
  workspaceFolder(): string | null;
  /** Bob's open folder as the genuine `vscode.WorkspaceFolder` to pass to startTask (Bob reads `.uri.fsPath`
   *  off it). Opaque so the driver carries no `vscode` type; null when none open. */
  workspaceFolderObject(): unknown;
}

export interface InProcessDriverOptions {
  /** Open the task store. Default: the live `~/.bob/db/bob.db` (read-only), or null when it doesn't exist
   *  yet (cold start). Tests inject a synthetic db (return null to simulate a not-yet-created store). */
  openStore?: () => Bob2TaskStore | null;
  /** Apply the 2.0 auto-approve config once on connect. Default: V4 `writeAutoApprove` to settings.json. */
  writeApproval?: () => void;
  /** Completion-watch poll cadence (ms). */
  pollMs?: number;
  /** Quiescence window (ms): how long `updated_at` must be still before a turn reads as done. */
  quietMs?: number;
  /** How long to wait for our new task row to materialize after startTask returns no id (ms). */
  correlateTimeoutMs?: number;
}

/**
 * Map a settled task-store row to a DispatchResult. A real error (last_error set, not the "null" sentinel)
 * → aborted, checked FIRST so a failure isn't masked. Otherwise a settled turn → completed (Bob leaves a
 * finished task at 'active', so "settled" = the turn went quiet, which IS completion here); an unsettled
 * row (wall-clock elapsed mid-turn) → timeout. The raw Bob status is carried in lastText for diagnostics.
 * `extras` carries the V6 reads off bob.db: `result` (Bob's summary, only meaningful on completion),
 * `tokensUsed` (output tokens from `costs`), and `maxIdleMs` (stall-watchdog telemetry) — both on any outcome.
 */
export function mapOutcome(
  row: Bob2TaskRow | null,
  settled: boolean,
  extras: { result?: string; tokensUsed?: number; maxIdleMs?: number } = {},
): DispatchResult {
  const err = row ? taskError(row) : null;
  const detail = row ? `bob2 status=${row.status}${err ? ` error=${err}` : ""}` : "";
  const base = {
    taskId: row?.id ?? null,
    result: "",
    lastText: detail,
    tokensUsed: extras.tokensUsed ?? 0,
    turns: 0,
    maxIdleMs: extras.maxIdleMs ?? 0,
  };
  if (err) return { ...base, status: "aborted" };
  if (settled) return { ...base, status: "completed", result: extras.result ?? "" };
  return { ...base, status: "timeout" };
}

// Removed 1.x built-ins our auto-router still emits; Bob 2.0 throws `Mode with id "<x>" not found` on them
// (built-ins are agent/ask/plan/review, coding = agent). Nothing else is rewritten.
const BOB2_REMOVED_BUILTIN_MODES: Record<string, string> = { code: "agent", advanced: "agent", orchestrator: "agent" };

/**
 * Board slug → a mode Bob 2.0 resolves. Only the removed 1.x built-ins are rewritten; the 2.0 built-ins
 * and every custom mode pass through, since Bob 2.0 loads custom_modes.yaml (so review/refactor/devsecops
 * dispatch as themselves; an unregistered slug then surfaces Bob's clean "Mode not found"). No mode → agent.
 */
export function toBob2Mode(mode: string | undefined | null): string {
  if (!mode) return "agent";
  return BOB2_REMOVED_BUILTIN_MODES[mode] ?? mode;
}

// A crashed/killed Bob window can leave its root stuck at status='running'; only count a running root as a
// live chat if it bumped within this window, so defer self-heals instead of wedging forever (1.x evictStale).
const STALE_RUNNING_MS = 5 * 60_000;
// Cap on remembered own-dispatch ids: foreignActivity only scans recently-active roots, so an id evicted
// after this many newer dispatches can't reappear there — bounds the Set on a long-lived loop.
const MAX_OWN_IDS = 256;

export class InProcessDriver implements BobDriver {
  private handle: Bob2StartTask | null = null;
  private approvalWritten = false;
  private busy = false;
  // Root ids WE dispatched (each startTask makes a fresh root on 2.0, incl. verify-and-continue re-dispatches),
  // so externalActivity can tell our own running task from a user's live chat on the shared global db.
  private readonly ownIds = new Set<string>();
  private readonly pollMs: number;
  private readonly quietMs: number;
  private readonly correlateTimeoutMs: number;

  constructor(
    private readonly host: Bob2Host,
    private readonly opts: InProcessDriverOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 1000;
    this.quietMs = opts.quietMs ?? 8000;
    this.correlateTimeoutMs = opts.correlateTimeoutMs ?? 15_000;
  }

  /** Resolve the in-process handle and apply auto-approve once. Throws when startTask isn't reachable
   *  (not a Bob 2.0 window) so the caller can fall back to the IPC driver. The handle is set LAST, so a
   *  failed approval write leaves the driver unconnected and a later connect retries it. */
  async connect(): Promise<void> {
    const ex = this.host.exports();
    if (!ex || typeof ex.startTask !== "function") {
      throw new Error(
        "Bob 2.0 in-process driver: IBM.bob-code exports.startTask is not reachable (not a Bob 2.0 window?)",
      );
    }
    // Auto-approve is config-driven on 2.0 (no per-prompt press to drive headless), so write it once up
    // front; a dispatch with the gate still armed would wedge on the first permission prompt.
    if (!this.approvalWritten) {
      (this.opts.writeApproval ?? (() => void writeAutoApprove()))();
      this.approvalWritten = true;
    }
    this.handle = ex;
  }

  /** Native on 2.0: the open folder comes straight from the VS Code API via the host (no IPC handshake). */
  queryWorkspace(): Promise<string | null> {
    return Promise.resolve(this.host.workspaceFolder());
  }

  /**
   * Dispatch one task and resolve to a terminal DispatchResult — never reject (the BobDriver contract a
   * BobClient also upholds), except the busy guard, which throws like BobClient so two overlapping
   * dispatches can't both correlate the same newest root.
   */
  async dispatch(opts: DispatchCore): Promise<DispatchResult> {
    if (this.busy) throw new Error("InProcessDriver is busy — dispatch tasks sequentially");
    this.busy = true;
    try {
      return await this.runDispatch(opts);
    } finally {
      this.busy = false;
    }
  }

  /** No persistent watcher between dispatches (the store is opened per-dispatch), so close is a no-op. */
  close(): void {}

  /** Remember a root we dispatched so externalActivity won't read it as a user chat, bounded so a long-lived
   *  loop's Set can't grow without limit (Set keeps insertion order → evict the oldest). NOTE: a dispatch
   *  that fails to correlate has no id to record, so its orphaned 'running' root may briefly read as foreign
   *  until it completes or the staleness clamp ages it out — a bounded, self-correcting spurious defer. */
  private rememberOwn(id: string): void {
    this.ownIds.add(id);
    if (this.ownIds.size > MAX_OWN_IDS) {
      const oldest = this.ownIds.values().next().value;
      if (oldest !== undefined) this.ownIds.delete(oldest);
    }
  }

  /**
   * Defer-while-chatting (2.0): is the user actively in a Bob chat in our workspace, so the loop should hold
   * dispatch? Polls bob.db (2.0 has no event stream): defer if a FOREIGN root is running (within the
   * staleness clamp) or was touched within `idleMs` (the grace window that keeps the worker from barging in
   * the instant you stop typing). Cannot reject and cannot wedge: a cold start / unopenable store / any
   * bob.db fault returns false (worst case it dispatches over a chat — the pre-port behavior). Comparing
   * `updated_at >= now-idleMs` in SQL (not `now - updated_at`) also avoids a future-dated row deferring forever.
   */
  async externalActivity(idleMs: number): Promise<boolean> {
    let store: Bob2TaskStore | null;
    try {
      store = this.openStore();
    } catch {
      return false;
    }
    if (!store) return false;
    try {
      const now = Date.now();
      const { running, activeRecently } = store.foreignActivity(this.ownIds, this.host.workspaceFolder(), {
        activeSinceMs: now - idleMs,
        runningSinceMs: now - STALE_RUNNING_MS,
      });
      return running || activeRecently;
    } catch {
      return false; // a transient bob.db fault must neither wedge the loop into deferring nor reject the poll
    } finally {
      store.close();
    }
  }

  private async runDispatch(opts: DispatchCore): Promise<DispatchResult> {
    // Validate the workspace BEFORE connect(), which writes settings.json — a doomed dispatch must not
    // mutate the user's global config as a side effect.
    const dir = this.host.workspaceFolder();
    if (!dir) return fail("no open workspace folder to dispatch into");
    if (!this.handle) {
      try {
        await this.connect();
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    // Open the store (held for the whole dispatch, closed once in finally). A genuinely-absent db is the
    // cold-start case (null → correlate after startTask creates it); a present-but-unopenable db is a
    // real fault we surface, NOT silently swallowed as "not created yet".
    let store: Bob2TaskStore | null;
    try {
      store = this.openStore();
    } catch (e) {
      return fail(`task store: ${(e as Error).message}`);
    }
    const snapshot = store ? store.snapshotRoots() : { ids: new Set<string>(), sinceMs: 0 };
    try {
      try {
        // workspaceFolder = the WorkspaceFolder object; mode a slug Bob resolves (see Bob2StartTask / toBob2Mode).
        await this.handle!.startTask({
          content: opts.text,
          mode: toBob2Mode(opts.mode),
          workspaceFolder: this.host.workspaceFolderObject() ?? undefined,
        });
      } catch (e) {
        return fail(`startTask failed: ${(e as Error).message}`);
      }
      if (!store) {
        // Cold start: startTask just created bob.db — open it now to correlate.
        try {
          store = this.openStore();
        } catch (e) {
          return fail(`task store (post-start): ${(e as Error).message}`);
        }
      }
      const id = store ? await this.correlate(store, snapshot, opts.text) : null;
      if (!store || id === null) {
        // startTask returned but no new root row matched within the window: a hard wiring failure
        // (db never materialized, or directory/timing assumptions wrong) — surface it, don't fake idle.
        return fail("dispatched task did not appear in bob.db (could not correlate)");
      }
      this.rememberOwn(id); // ours, not a user chat — so the defer signal won't pause on our own dispatch
      const { settled, row, maxGapMs } = await awaitTurnSettled(store, id, {
        pollMs: this.pollMs,
        quietMs: this.quietMs,
        timeoutMs: opts.timeoutMs ?? 300_000,
      });
      // V6: enrich the outcome from bob.db — output tokens (any outcome) + Bob's summary text (only on a
      // clean completion; a timeout/error row's last message would be partial/misleading). maxGapMs is
      // stall-watchdog telemetry (see DispatchResult.maxIdleMs).
      const tokensUsed = parseCosts(row?.costs ?? null)?.output ?? 0;
      const result = settled && row && !taskError(row) ? (store.readResultText(id) ?? "") : "";
      return mapOutcome(row, settled, { result, tokensUsed, maxIdleMs: maxGapMs });
    } finally {
      store?.close();
    }
  }

  /** The injected opener, or the live store — null when bob.db doesn't exist yet (cold start), throwing
   *  only on a real open error (the caller maps that to a failure, not a retry). */
  private openStore(): Bob2TaskStore | null {
    if (this.opts.openStore) return this.opts.openStore();
    if (!bob2DbExists()) return null;
    return Bob2TaskStore.open();
  }

  /**
   * Find our task's row after startTask (which returns none): poll for the new root that wasn't in the
   * pre-dispatch snapshot, matched to our `content` so a concurrent dispatch from another Bob window on the
   * shared db can't be mistaken for ours. Returns its id, or null if nothing matches within correlateTimeoutMs.
   */
  private async correlate(
    store: Bob2TaskStore,
    snapshot: { ids: Set<string>; sinceMs: number },
    content: string,
  ): Promise<string | null> {
    const deadline = Date.now() + this.correlateTimeoutMs;
    for (;;) {
      const row = store.newRootSince(snapshot.ids, snapshot.sinceMs, content);
      if (row) return row.id;
      if (Date.now() >= deadline) return null;
      await sleep(this.pollMs);
    }
  }
}

/** A non-success dispatch that ended before (or without) a correlated task — mapped to 'aborted' (a hard
 *  failure the worker surfaces), never thrown, so callers can treat both drivers interchangeably. */
function fail(reason: string): DispatchResult {
  return { taskId: null, result: "", lastText: reason, status: "aborted", tokensUsed: 0, turns: 0 };
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
