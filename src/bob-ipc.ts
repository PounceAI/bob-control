import net from "node:net";
import { IdleWatchdog } from "./watchdog.js";
import { BudgetTracker, budgetExceeded, parseApiReqUsage } from "./budget.js";
import { TaskBinder } from "./task-binder.js";
import { isCommandAsk } from "./command-policy.js";
import type { BobDriver } from "./bob-driver.js";

/**
 * Async client for IBM Bob's Roo Code IPC socket. Wire protocol (from
 * bob-control.mjs):
 *   - node-ipc framing: each message is JSON + "\f" (form-feed) delimiter.
 *   - every frame is wrapped in a {type:"message", data:<IpcMessage>} envelope
 *     (unwrap on receive, wrap on send).
 *   - server sends an Ack (carrying our clientId) before accepting commands.
 *   - lifecycle TaskEvents deliver payload as [taskId, ...]; chat events deliver
 *     [{taskId, message:{say|ask, text}}]. The answer is say:"completion_result".
 *   - a StartNewTask without newTab reuses the current tab and aborts whatever was
 *     there, so we bind to our task id (first taskCreated/taskStarted after send)
 *     and only treat terminal events for that id as ours.
 *
 * Keeps a persistent connection and dispatches tasks sequentially.
 */

const DELIM = "\f";
// Cap the receive buffer so a peer that never sends a frame delimiter can't grow it without bound.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
// Cap accumulated review findings so a flood of submit_review_findings frames can't grow unbounded.
const MAX_REVIEW_FINDINGS = 1000;

/**
 * The transport-shared dispatch inputs BOTH drivers honor. The 2.0 in-process driver can't honor the
 * 1.x gate fields below (it has no event stream to drive a watchdog/budget/classifier off — see
 * docs/bob-2-inprocess.md), so the `BobDriver` seam is typed on this subset; `DispatchOptions` adds the
 * 1.x-only fields and is what `BobClient` takes.
 */
export interface DispatchCore {
  text: string;
  /** Bob mode slug; sent as configuration.mode. Omit to use Bob's current mode. */
  mode?: string | null;
  /**
   * Extra fields merged into the dispatch `configuration` (the Bob settings
   * schema), e.g. per-mode auto-approve toggles. `mode` is applied on top.
   */
  config?: Record<string, unknown>;
  /** Open in a new editor tab (steals focus). Default false = quiet sidebar. */
  newTab?: boolean;
  /** Per-task timeout. Default 300000ms (5 min). */
  timeoutMs?: number;
}

export interface DispatchOptions extends DispatchCore {
  /**
   * Optional live event callback for logging/progress. `ask` is set (e.g. "command")
   * when Bob is *blocking for approval* rather than just narrating (`say`); the
   * classifier keys off `ask === "command"` to approve/deny a pending command.
   */
  onEvent?: (
    name: string,
    detail: {
      say?: string;
      ask?: string;
      text?: string;
      partial?: boolean;
      ts?: number;
      taskId?: string;
      isRoot?: boolean;
    },
  ) => void;
  /**
   * Idle / blocked-on-ask watchdog window (ms). When the dispatch makes no progress for this long
   * it ends as 'idle' instead of burning the full wall-clock. <= 0 or omitted disables it.
   */
  idleMs?: number;
  /** Shorter window once an UNANSWERABLE blocking ask is seen, so a permission-prompt wedge ends
   *  fast. <= 0 falls back to idleMs. Only meaningful with idleMs > 0. */
  blockedAskGraceMs?: number;
  /** Predicate: will a gate answer this ask? An ask that returns false is "unanswerable" and trips
   *  the watchdog's short grace. The ask's payload text is passed so a followup can be classified
   *  (auto-answer vs escalate). Omitted → every ask is treated as unanswerable. */
  isAnswerableAsk?: (ask: string, text?: string) => boolean;
  /** Hard output-token ceiling; the dispatch ends as 'budget' once it's exceeded. <= 0 disables. */
  tokenCeiling?: number;
  /** Hard turn (api-request) cap; the dispatch ends as 'budget' once exceeded. <= 0 disables. */
  turnCap?: number;
}

export interface ReviewIssue {
  title: string;
  description: string;
  file?: string;
  filePath?: string;
  line?: number;
  severity: string;
  category: string;
  fixed_diff?: string;
}

export interface DispatchResult {
  taskId: string | null;
  /** Genuine attempt_completion text Bob emitted, or "" if it never did. */
  result: string;
  /** Last non-empty streamed say text (e.g. a tool call) — diagnostics only, NOT a completion. */
  lastText: string;
  /**
   * How the dispatch ended:
   *  - completed: Bob fired taskCompleted / attempt_completion.
   *  - aborted:   the pipe dropped or Bob aborted the task.
   *  - timeout:   the flat wall-clock elapsed.
   *  - idle:      the watchdog tripped (no progress, or wedged on an unanswerable ask).
   *  - budget:    the token/turn ceiling was exceeded (runaway backstop).
   */
  status: "completed" | "aborted" | "timeout" | "idle" | "budget";
  /** Review findings from submit_review_findings tool (review mode only). */
  reviewFindings?: ReviewIssue[];
  /** The blocking ask still pending when the dispatch ended (drives a needs_input question). */
  pendingAsk?: string;
  /** That ask's payload text (e.g. the command awaiting approval). */
  pendingAskText?: string;
  /** Output tokens observed (from api-request events); 0 when Bob didn't report usage. */
  tokensUsed?: number;
  /** Distinct api requests observed (≈ assistant turns). */
  turns?: number;
}

export interface TaskLifecycleEvent {
  /** e.g. taskCreated | taskStarted | taskCompleted | taskAborted */
  name: string;
  taskId: string;
  /** True if this event belongs to the worker's own dispatch tree (the bound root or a subtask it
   *  spawned). Subtasks count as own so an orchestrator's children don't read as external chat. */
  isOwn: boolean;
}

interface ActiveDispatch {
  ourTaskId: string | null;
  lastCompletion: string;
  lastText: string;
  reviewFindings?: ReviewIssue[];
  settle: (r: DispatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onEvent?: DispatchOptions["onEvent"];
  done: boolean;
  /** Idle / blocked-on-ask watchdog (undefined when disabled). */
  watchdog?: IdleWatchdog;
  /** Accumulates token usage to enforce the budget ceiling. */
  budget: BudgetTracker;
  tokenCeiling?: number;
  turnCap?: number;
  isAnswerableAsk?: (ask: string, text?: string) => boolean;
  /** The blocking ask currently awaiting a response (cleared when progress resumes). */
  pendingAsk?: string;
  pendingAskText?: string;
}

/**
 * Pick the IPC pipe to dispatch over: explicit arg › BOB_IPC_PIPE › the host Bob's own
 * ROO_CODE_IPC_SOCKET_PATH (so a worker pairs with ITS instance, not whichever owns the shared global
 * pipe) › the legacy pre-doubled default. Blank/whitespace at any level falls through, so a set-but-empty
 * env var (or `--pipe ""`) can't resolve to "" and strand the worker on net.connect("").
 */
export function resolvePipe(p?: string): string {
  const nonBlank = (s: string | undefined): string | undefined => (s && s.trim() ? s : undefined);
  return (
    nonBlank(p) ??
    nonBlank(process.env.BOB_IPC_PIPE) ??
    nonBlank(process.env.ROO_CODE_IPC_SOCKET_PATH) ??
    "\\\\.\\pipe\\pipe\\bob-ipc"
  );
}

/**
 * taskCompleted payload is positional: [taskId, {tokens}, {tool counts}, {isSubtask}]. Returns the
 * flag if present, else undefined (taskAborted carries just [taskId]). Callers must treat undefined
 * as "unknown", not false — the terminal-release releases on taskAborted OR isSubtask===false.
 */
export function parseIsSubtask(payload: unknown): boolean | undefined {
  if (!Array.isArray(payload)) return undefined;
  for (const el of payload) {
    if (el && typeof el === "object" && "isSubtask" in el) {
      return (el as { isSubtask?: unknown }).isSubtask === true;
    }
  }
  return undefined;
}

export class BobClient implements BobDriver {
  private sock: net.Socket | null = null;
  private buffer = "";
  private clientId: string | null = null;
  private active: ActiveDispatch | null = null;
  private connected = false;
  private connectSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: ((ev: TaskLifecycleEvent) => void) | null = null;
  // One-shot waiter for a GetWorkspace reply (the layer-2 workspace handshake). Set by queryWorkspace,
  // resolved by handle() on the workspaceInfo TaskEvent, cleared on resolve/timeout.
  private workspaceWaiter: ((fsPath: string | null) => void) | null = null;
  // Owns the dispatch→task-id binding, ignoring foreign (chat) tasks so an open Bob chat
  // can't steal it. Long-lived (not per-dispatch) so foreign chats stay tracked across runs.
  private binder = new TaskBinder();
  readonly pipe: string;

  constructor(pipe?: string) {
    this.pipe = resolvePipe(pipe);
  }

  /**
   * Observe all Bob task lifecycle events, including external ones the worker
   * didn't dispatch (the user chatting). `isOwn` marks events belonging to the
   * in-flight dispatch. Used for defer-while-chatting.
   */
  onTaskEvent(fn: (ev: TaskLifecycleEvent) => void): void {
    this.observer = fn;
  }

  /**
   * Connect and resolve once the server's Ack arrives. Re-callable: a dropped client can be
   * reconnected by calling this again (see dispatch's reconnect). Rejects — instead of hanging
   * forever — if no Ack arrives within `timeoutMs` (a half-up Bob whose pipe exists but never acks).
   */
  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectSettle = { resolve, reject };
      this.connectTimer = setTimeout(() => {
        this.connectSettle = null;
        this.teardownSocket();
        reject(new Error(`Bob IPC connect timed out after ${timeoutMs}ms (${this.pipe})`));
      }, timeoutMs);
      this.connectTimer.unref?.();
      this.open(this.pipe, false);
    });
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Detach + destroy the current socket so a stale one can't fire handlers or leak a handle. */
  private teardownSocket(): void {
    this.workspaceWaiter?.(null); // settle a handshake query awaiting this socket (close()/connect-timeout)
    const sock = this.sock;
    this.sock = null;
    this.connected = false;
    if (sock) {
      sock.removeAllListeners();
      sock.destroy();
    }
  }

  private open(path: string, isRetry: boolean): void {
    const sock = net.connect(path);
    this.sock = sock;
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("error", (err: NodeJS.ErrnoException) => {
      // node-ipc sometimes registers \\.\pipe\bob-ipc as \\.\pipe\pipe\bob-ipc.
      if (err.code === "ENOENT" && !isRetry) {
        const doubled = path.replace(/^(\\\\\.\\pipe\\)(?!pipe\\)/, "$1pipe\\");
        if (doubled !== path) {
          // Tear the failed socket down (listeners + handle) before retrying the doubled path,
          // so the orphaned socket can't later fire a stale close/error against a live dispatch.
          sock.removeAllListeners();
          sock.destroy();
          this.open(doubled, true);
          return;
        }
      }
      this.connected = false;
      if (this.connectSettle) {
        // Failure during connect: reject the connect() promise.
        this.clearConnectTimer();
        this.connectSettle.reject(err);
        this.connectSettle = null;
      } else {
        // Error after connect (e.g. EPIPE writing to a dropped pipe): abort any in-flight dispatch.
        this.finish("aborted");
      }
    });
    sock.on("close", () => {
      // The pipe dropped. Null the socket so the next dispatch reconnects instead of writing into a
      // dead handle, and surface any mid-flight task as aborted rather than hanging out the timeout.
      if (this.sock === sock) {
        this.sock = null;
        this.connected = false;
      }
      this.finish("aborted");
    });
  }

  /** Write a framed message. Never throws — returns false if the socket is gone or the write fails,
   *  so callers (cancel/approve/sendMessage) can't leak an unhandled rejection on a dropped pipe. */
  private send(obj: unknown): boolean {
    if (!this.sock) return false;
    try {
      this.sock.write(JSON.stringify({ type: "message", data: obj }) + DELIM);
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // A peer that never sends a delimiter must not grow the buffer without bound: once past the cap,
    // keep only the tail after the last delimiter (a partial frame), or drop it entirely.
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      const lastDelim = this.buffer.lastIndexOf(DELIM);
      this.buffer = lastDelim === -1 ? "" : this.buffer.slice(lastDelim + 1);
    }
    let idx: number;
    while ((idx = this.buffer.indexOf(DELIM)) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!raw.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      this.handle(msg);
    }
  }

  private handle(msg: any): void {
    if (msg && msg.type === "message" && msg.data) msg = msg.data;

    if (msg.type === "Ack") {
      this.clientId = msg.data?.clientId ?? null;
      this.connected = true;
      this.clearConnectTimer();
      this.connectSettle?.resolve();
      this.connectSettle = null;
      return;
    }

    if (msg.type === "TaskEvent") {
      const ev = msg.data ?? {};
      const name: string = ev.eventName ?? ev.event ?? ev.type ?? "event";
      const payload = ev.payload ?? ev.data ?? ev;

      // GetWorkspace reply (layer-2 handshake): not a task event — resolve the waiter and stop, so it
      // never reaches the binder/dispatch logic. fsPath blank/non-string → null (unverifiable).
      if (/^workspaceInfo$/i.test(name)) {
        if (this.workspaceWaiter) {
          const raw = typeof payload?.fsPath === "string" ? payload.fsPath.trim() : "";
          this.workspaceWaiter(raw || null);
        }
        return;
      }

      const rawTaskId =
        payload?.taskId ??
        (Array.isArray(payload) ? (typeof payload[0] === "string" ? payload[0] : payload[0]?.taskId) : undefined);
      // Only accept a string task id — a malformed/non-string id must not bind or settle a dispatch.
      const taskId: string | undefined = typeof rawTaskId === "string" ? rawTaskId : undefined;

      // Track binding for every event (even when idle) so a chat opened between dispatches is
      // already known-foreign next time and can't steal our binding. See TaskBinder.
      this.binder.observe(name, taskId);

      // Active-dispatch handling: capture result, settle on terminal.
      if (this.active) {
        // TaskBinder owns the bind decision; the rest of the client reads active.ourTaskId
        // (budget/watchdog/settle/approve), so mirror the bound id onto it.
        this.active.ourTaskId = this.binder.taskId;

        // Two scopes (see TaskBinder): isRoot = the bound root, fail-open for undefined/pre-bind ids;
        // isOwnTree = root or an adopted subtask/grandchild. Result-capture, ask-grace and onEvent are
        // root-only; budget, idle-progress and newTask-adoption span the tree. A user chat is neither
        // (no newTask provenance), so it falls through and still defers.
        const isRoot = !(taskId && this.active.ourTaskId && taskId !== this.active.ourTaskId);
        const isOwnTree = isRoot || this.binder.isOwned(taskId);

        // Extract any chat message (say/ask + text) from the payload.
        const arr = Array.isArray(payload) ? payload : [payload];
        const cline = arr.map((p: any) => p?.message ?? p).find((m: any) => m && (m.text || m.say || m.ask));
        if (cline && isOwnTree) {
          const ask: string | undefined = cline.ask;
          const say: string | undefined = cline.say ?? cline.ask;
          const text: string = String(cline.text ?? "");
          const partial = !!cline.partial;
          // Message timestamp; the gates + budget dedup on it (a re-emit shares ts, a re-run gets a new one).
          const ts: number | undefined = typeof cline.ts === "number" ? cline.ts : undefined;
          // Root-only: a subtask's completion_result is its answer to the orchestrator, not the dispatch's.
          if (isRoot) {
            if (say === "completion_result" && text.trim()) this.active.lastCompletion = text;
            else if (text.trim()) this.active.lastText = text;
          }

          // Budget backstop (whole tree): accumulate per-request output tokens and abort over ceiling/turns.
          // Key by taskId:ts so a re-emit dedups (last-wins) but root and a subtask sharing a ts stay distinct.
          if (say === "api_req_started") {
            const usage = parseApiReqUsage(text);
            if (usage) {
              const budgetKey = taskId !== undefined && ts !== undefined ? `${taskId}:${ts}` : ts;
              this.active.budget.update(budgetKey, usage);
              const over = budgetExceeded(this.active.budget, {
                tokenCeiling: this.active.tokenCeiling,
                turnCap: this.active.turnCap,
              });
              if (over) {
                if (this.active.ourTaskId) this.cancel(this.active.ourTaskId);
                this.finish("budget");
                return;
              }
            }
          }

          // Idle watchdog. A final blocking ask arms the short grace — root-only (we don't press a
          // subtask's ask here; a wedged subtask still trips on the full window). Any non-ask message
          // anywhere in the tree is progress and resets the window — the starvation fix. (Assumes
          // sequential delegation: if a subtask emits while the root holds an ask, activity() clears the
          // grace → at worst one full idle window, never indefinite.) Partial asks don't reset the grace.
          if (ask) {
            if (isRoot && !partial) {
              this.active.pendingAsk = ask;
              this.active.pendingAskText = text;
              const answerable = this.active.isAnswerableAsk ? this.active.isAnswerableAsk(ask, text) : false;
              this.active.watchdog?.ask(ask, text, answerable);
            }
          } else {
            if (isRoot) {
              this.active.pendingAsk = undefined;
              this.active.pendingAskText = undefined;
            }
            this.active.watchdog?.activity();
          }

          // submit_review_findings: capture (root-only, result capture). newTask: arm adoption of the
          // next create — tree-wide, so a subtask's own newTask adopts a grandchild; only an owned
          // task's spawn arms it, so a user chat can't inject one.
          if (say === "tool" && text && !partial) {
            try {
              const parsed = JSON.parse(text);
              if (isRoot && parsed.tool === "submit_review_findings" && Array.isArray(parsed.issues)) {
                // Append across calls (Bob may emit findings in batches); capped so a flood can't grow unbounded.
                this.active.reviewFindings = [...(this.active.reviewFindings ?? []), ...parsed.issues].slice(
                  0,
                  MAX_REVIEW_FINDINGS,
                );
              } else if (parsed.tool === "newTask") {
                this.binder.noteSpawnFrom(taskId, ts);
              }
            } catch {
              // Ignore parse errors; text may be incomplete or not JSON
            }
          }

          // onEvent runs the worker's gates. Route every root event, plus an owned subtask's COMMAND
          // ask (carrying taskId, so the press hits the subtask's own instance) so a pytest-style prompt
          // is pressed instead of stalling. Command asks only — a subtask's followup/mode-switch ask
          // isn't routed (no auto-answering a user's chat). Only owned tasks reach here; the create-race
          // mis-adoption residual is documented in docs/defer-known-issues.md.
          const routeToGates = isRoot || (!partial && ask !== undefined && isCommandAsk(ask));
          if (routeToGates) this.active.onEvent?.(name, { say, ask, text, partial, ts, taskId, isRoot });
        } else if (!cline && isRoot) {
          // Lifecycle-only event (no message): forward to onEvent but don't reset the idle window — a
          // wedge on an ask emits no messages, so counting these as progress would mask the wedge.
          this.active.onEvent?.(name, { isRoot: true });
        }
      }

      // Report every lifecycle event (even while idle) so callers can detect external chat activity.
      if (taskId && this.observer && /taskCreated|taskStarted|taskCompleted|taskAborted/i.test(name)) {
        // isOwn = in our tree (root or adopted subtask), so subtasks don't read as external chat and
        // trip defer; a user chat (no newTask provenance) isn't owned and still defers.
        const isOwn = this.binder.isOwned(taskId);
        this.observer({ name, taskId, isOwn });
      }

      const terminal = /taskCompleted|taskAborted/i.test(name);
      // Release an adopted subtask on its terminal so `owned` stays bounded: a real subtask's final
      // terminal is taskAborted; a non-root task that completed top-level (isSubtask:false) was a
      // create-race mis-adoption — un-own it either way. releaseChild never drops the root.
      if (terminal && taskId && taskId !== this.binder.taskId && this.binder.isOwned(taskId)) {
        if (/taskAborted/i.test(name) || parseIsSubtask(payload) === false) this.binder.releaseChild(taskId);
      }
      // Only settle for our task; ignore a prior task aborting on tab reuse.
      if (this.active && terminal && this.active.ourTaskId && taskId === this.active.ourTaskId) {
        this.finish(/taskAborted/i.test(name) ? "aborted" : "completed");
      }
      return;
    }
  }

  private finish(status: DispatchResult["status"]): void {
    // On a pipe drop, settle a pending handshake query null — else its unref'd timer can't keep the
    // worker alive and queryWorkspace's promise never resolves (silent exit). Only on "aborted".
    if (status === "aborted") this.workspaceWaiter?.(null);
    const a = this.active;
    if (!a || a.done) return;
    a.done = true;
    clearTimeout(a.timer);
    a.watchdog?.stop();
    this.binder.disarm();
    this.active = null;
    a.settle({
      taskId: a.ourTaskId,
      // Only a genuine completion_result counts as the result; the trailing
      // streamed text (e.g. an updateTodoList tool-say) is diagnostics only, so a
      // timeout with no completion_result yields result:"" → worker parks blocked.
      result: a.lastCompletion,
      lastText: a.lastText,
      status,
      reviewFindings: a.reviewFindings,
      pendingAsk: a.pendingAsk,
      pendingAskText: a.pendingAskText,
      tokensUsed: a.budget.outputTokens,
      turns: a.budget.turns,
    });
  }

  /** Dispatch one task and resolve when it completes (or aborts / times out). Reconnects first if
   *  the pipe dropped since the last dispatch, so a Bob restart between tasks doesn't wedge the worker. */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    if (this.active) throw new Error("BobClient is busy — dispatch tasks sequentially");
    if (!this.connected || !this.sock) await this.connect(); // (re)connect if never connected or dropped
    const timeoutMs = opts.timeoutMs ?? 300_000;
    return new Promise<DispatchResult>((resolve) => {
      const active: ActiveDispatch = {
        ourTaskId: null,
        lastCompletion: "",
        lastText: "",
        settle: resolve,
        onEvent: opts.onEvent,
        done: false,
        budget: new BudgetTracker(),
        tokenCeiling: opts.tokenCeiling,
        turnCap: opts.turnCap,
        isAnswerableAsk: opts.isAnswerableAsk,
        timer: setTimeout(() => this.finish("timeout"), timeoutMs),
      };
      active.timer.unref?.();
      // Idle / blocked-on-ask watchdog: ends a wedged dispatch (e.g. stuck on an unanswerable
      // command-permission prompt) well before the wall clock, cancelling the Bob task on the way out.
      if (opts.idleMs && opts.idleMs > 0) {
        active.watchdog = new IdleWatchdog({
          idleMs: opts.idleMs,
          blockedAskGraceMs: opts.blockedAskGraceMs ?? 0,
          onTrip: () => {
            const a = this.active;
            if (!a || a.done) return;
            if (a.ourTaskId) this.cancel(a.ourTaskId);
            this.finish("idle");
          },
        });
      }
      this.binder.arm();
      this.active = active;
      active.watchdog?.start();
      const sent = this.send({
        type: "TaskCommand",
        origin: "client",
        clientId: this.clientId,
        data: {
          commandName: "StartNewTask",
          data: {
            configuration: {
              ...(opts.config ?? {}),
              ...(opts.mode ? { mode: opts.mode } : {}),
            },
            text: opts.text,
            newTab: opts.newTab ?? false,
          },
        },
      });
      // Socket write failed (dropped pipe): settle now instead of waiting out the timeout.
      if (!sent) this.finish("aborted");
    });
  }

  /** Cancel the in-flight dispatch's Bob task, if one is bound. Used by the permission gate to end a
   *  dispatch promptly on a blocking deny (so a denied command can't burn the wall-clock). */
  cancelActive(): void {
    if (this.active?.ourTaskId) this.cancel(this.active.ourTaskId);
  }

  /** Cancel a running Bob task by id. */
  cancel(taskId: string): void {
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "CancelTask", data: taskId },
    });
  }

  /**
   * Answer a pending approval: primary = approve/run, secondary = reject. Requires the Bob button
   * patch (tools/patch-bob-buttons.mjs) — without it the IPC switch ignores these commands.
   *
   * The `data` task id selects which webview to press: the patch presses the instance whose
   * getCurrentTask().taskId matches (else the sole running instance, else no-op), so it never presses
   * an idle sidebar (which would abort a --new-tab task). Defaults to the bound root; pass an owned
   * subtask's id to press that subtask's prompt directly rather than via the sole-runner fallback.
   */
  approve(taskId?: string): void {
    const target = this.resolvePressTarget(taskId);
    if (target === undefined) return; // no dispatch in flight, or target no longer ours — drop the press
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "PressPrimaryButton", data: target },
    });
  }

  reject(taskId?: string): void {
    const target = this.resolvePressTarget(taskId);
    if (target === undefined) return; // no dispatch in flight, or target no longer ours — drop the press
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "PressSecondaryButton", data: target },
    });
  }

  /**
   * Resolve+validate a press target (the single choke point for approve/reject). Returns the id to
   * press, or undefined to DROP it — no dispatch in flight, or a non-root id no longer owned, so a
   * LATE verdict (async classifier, or a self-corrected mis-adoption) can't press a now-foreign task.
   * The root is always owned mid-dispatch, so legitimate presses aren't blocked. `null` (pre-bind
   * root) is still sendable, distinct from `undefined` (drop).
   */
  private resolvePressTarget(taskId?: string): string | null | undefined {
    if (!this.active) return undefined;
    const target = taskId ?? this.active.ourTaskId;
    if (target && target !== this.active.ourTaskId && !this.binder.isOwned(target)) return undefined;
    return target;
  }

  /**
   * Send a chat message to the running task. When Bob is waiting on a followup
   * question (ask_followup_question), the message resolves it as the answer. This
   * is a native IPC command — no button patch needed (unlike approve/reject).
   */
  sendMessage(text: string): void {
    if (!this.active) return; // no dispatch in flight — nothing to answer
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "SendMessage", data: { text, images: [] } },
    });
  }

  /**
   * Layer-2 handshake: ask the connected Bob which workspace folder it has open, so the worker can
   * refuse to run git/edits against the wrong tree. Resolves the reported fsPath, or null when it
   * can't be learned — Bob lacks the GetWorkspace patch (the command is dropped, no reply), the reply
   * is malformed, or no reply lands within `timeoutMs`. Requires the bundle patch (patch-bob-buttons.mjs).
   */
  queryWorkspace(timeoutMs = 1500): Promise<string | null> {
    if (!this.connected || !this.sock) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const finish = (fsPath: string | null): void => {
        clearTimeout(timer);
        if (this.workspaceWaiter === finish) this.workspaceWaiter = null;
        resolve(fsPath);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      this.workspaceWaiter = finish;
      const sent = this.send({
        type: "TaskCommand",
        origin: "client",
        clientId: this.clientId,
        data: { commandName: "GetWorkspace" },
      });
      if (!sent) finish(null);
    });
  }

  close(): void {
    this.clearConnectTimer();
    try {
      this.sock?.end();
    } catch {
      /* ignore */
    }
    this.teardownSocket();
  }
}
