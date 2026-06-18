import net from "node:net";
import { IdleWatchdog } from "./watchdog.js";
import { BudgetTracker, budgetExceeded, parseApiReqUsage } from "./budget.js";
import { TaskBinder } from "./task-binder.js";
import { isCommandAsk } from "./command-policy.js";

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

export interface DispatchOptions {
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
  /**
   * Optional live event callback for logging/progress. `ask` is set (e.g. "command")
   * when Bob is *blocking for approval* rather than just narrating (`say`); the
   * classifier keys off `ask === "command"` to approve/deny a pending command.
   */
  onEvent?: (
    name: string,
    detail: { say?: string; ask?: string; text?: string; partial?: boolean; ts?: number; taskId?: string },
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

/** Default to the node-ipc-mangled doubled pipe that Bob actually registers. */
export function resolvePipe(p?: string): string {
  return p ?? process.env.BOB_IPC_PIPE ?? "\\\\.\\pipe\\pipe\\bob-ipc";
}

/**
 * A taskCompleted payload is positional: [taskId, {tokens…}, {tool counts…}, {isSubtask:boolean}].
 * Return the isSubtask flag if present, else undefined. taskAborted carries just [taskId], so it
 * yields undefined there. Callers MUST handle undefined explicitly rather than treat it as a value:
 * the terminal-release below releases on `taskAborted` OR `isSubtask === false`, so a taskCompleted
 * that omits the flag (undefined) is intentionally NOT released — a real subtask is popped by its
 * later taskAborted, and the owned set clears on the next arm() regardless.
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

export class BobClient {
  private sock: net.Socket | null = null;
  private buffer = "";
  private clientId: string | null = null;
  private active: ActiveDispatch | null = null;
  private connected = false;
  private connectSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: ((ev: TaskLifecycleEvent) => void) | null = null;
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

        // Two scopes, not one foreign/ours flag (see TaskBinder for the owned tree):
        //   • isRoot — the bound root. Fail-open: an undefined or pre-bind id counts as root, so the
        //     first frames before binding aren't dropped. Result-capture, the blocking-ask grace, and
        //     the worker's onEvent gates are ROOT-only.
        //   • isOwnTree — anywhere in our dispatch's tree: the root OR an adopted subtask/grandchild.
        //     Budget, idle-progress, and newTask-adoption span the WHOLE tree.
        // A genuine concurrent user chat is neither (no newTask provenance → never owned), so its
        // messages fall through untouched and still defer. The split fixes two orchestrator hazards:
        // a busy subtask emits no root events, so a root-only idle reset let the watchdog cancel a
        // healthy dispatch, and a subtask's tokens escaped the budget ceiling entirely.
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
          // `ts` is the message's unique timestamp — the gates + budget tracker dedup on it so a
          // re-emitted ask/usage is handled once while a genuine re-run (new ts) is handled again.
          const ts: number | undefined = typeof cline.ts === "number" ? cline.ts : undefined;
          // Result capture is ROOT-only: a subtask's completion_result is its own answer back to the
          // orchestrator, not the dispatch's result, and would clobber lastCompletion/lastText.
          if (isRoot) {
            if (say === "completion_result" && text.trim()) this.active.lastCompletion = text;
            else if (text.trim()) this.active.lastText = text;
          }

          // Budget backstop (WHOLE tree): accumulate token usage from Bob's per-request 'api_req_started'
          // say (Roo updates that one frame in place with final token counts under the same ts) and abort
          // cleanly once a runaway dispatch crosses the token ceiling (or turn cap). Counting subtasks too
          // closes the gap where an orchestrator's children burned tokens off-budget. Keying on the single
          // canonical event avoids double-counting a separate api_req_finished frame.
          if (say === "api_req_started") {
            const usage = parseApiReqUsage(text);
            if (usage) {
              this.active.budget.update(ts, usage);
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

          // Idle / blocked-on-ask watchdog.
          //   • A FINAL blocking ask arms the (short) grace — ROOT-only, since answering/pressing a
          //     subtask's prompt is out of scope here. A subtask that wedges on an ask still recovers:
          //     its last pre-ask message reset the window, which then elapses to a (full-window) trip.
          //   • Any non-ask message ANYWHERE in the tree is progress and resets the idle window. This is
          //     the starvation fix — a long subtask emits no root events, so the old root-only reset let
          //     the watchdog cancel a healthy orchestrator mid-run. ASSUMPTION (behavioral, not protocol-
          //     enforced): orchestrators delegate sequentially — the root is paused while a subtask runs
          //     — so subtask progress and a live root ask don't overlap. If they ever did, a subtask's
          //     activity() would clear the root's armed grace; worst case is then one FULL idle window
          //     before the trip (delayed recovery), never indefinite starvation, since progress did stop.
          // Partial ask fragments are ignored so a streaming prompt can't keep resetting the grace.
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

          // Tool calls we react to. (a) submit_review_findings (review mode): capture findings — ROOT
          // only, as a form of result capture. (b) newTask (orchestrator): note the spawn so the binder
          // adopts the child that follows. Adoption spans the WHOLE tree so a subtask's own newTask (a
          // grandchild) is adopted too; only an owned task's spawn arms it (noteSpawnFrom), so a user
          // chat can't inject one.
          if (say === "tool" && text && !partial) {
            try {
              const parsed = JSON.parse(text);
              if (isRoot && parsed.tool === "submit_review_findings" && Array.isArray(parsed.issues)) {
                // Append, don't overwrite: Bob may emit findings across multiple
                // submit_review_findings calls (e.g. high-severity then low) — last-wins
                // assignment would silently drop the earlier batches. Capped so a flood can't grow
                // the array without bound.
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

          // onEvent runs the worker's approve/reject/answer gates. Route every ROOT event (as before),
          // PLUS an owned SUBTASK's COMMAND permission ask — so a `pytest`-style prompt raised inside an
          // orchestrator subtask is pressed/denied by the same gates instead of stalling until the idle
          // watchdog. The press carries `taskId`, so it lands on the subtask's own webview instance.
          // Guard (the safety property): we're inside `cline && isOwnTree`, so a non-root here is an
          // adopted, owned task — a genuine user chat (no newTask provenance) is never owned, and a chat
          // mis-adopted in the create race is un-owned the instant it completes top-level (Increment 1).
          // ONLY command asks cross over: a subtask's followup/mode-switch ask is deliberately NOT routed
          // (avoids auto-answering a user's conversation). Residual: a chat mis-adopted in the sub-second
          // window before its top-level completion could be pressed — bounded by the gate's conservatism
          // (allowlist-approve / deny+surface) and the tininess of the race.
          const routeToGates = isRoot || (!partial && ask !== undefined && isCommandAsk(ask));
          if (routeToGates) this.active.onEvent?.(name, { say, ask, text, partial, ts, taskId });
        } else if (!cline && isRoot) {
          // A lifecycle-only event (no message) isn't counted as progress: a wedge on an ask emits
          // no messages, so letting these reset the idle window would mask exactly what we watch for.
          this.active.onEvent?.(name, {});
        }
      }

      // Report every lifecycle event (even while idle), flagging whether it's
      // our own dispatch so callers can detect external chat activity.
      if (taskId && this.observer && /taskCreated|taskStarted|taskCompleted|taskAborted/i.test(name)) {
        // Own = anywhere in our dispatch's task tree (the bound root or an adopted subtask), so an
        // orchestrator's subtasks don't read as external chat activity and spuriously trip defer. A
        // genuine user chat has no newTask provenance, isn't owned, and still defers correctly.
        const isOwn = this.binder.isOwned(taskId);
        this.observer({ name, taskId, isOwn });
      }

      const terminal = /taskCompleted|taskAborted/i.test(name);
      // Bound the owned tree and self-correct a mis-adoption when an ADOPTED subtask (an owned task
      // that isn't our root) reaches a terminal. A real subtask's FINAL terminal is taskAborted (the
      // orchestrator pops it after it completes), so release only then — a post-completion event of
      // this id still reads isOwn=true above and can't bump the defer idle-window. A task that
      // COMPLETED as top-level (isSubtask:false) but isn't our root was wrongly adopted in the
      // newTask→create race; un-own it so defer treats it correctly from here.
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
   * Answer a pending approval (e.g. a command ask): primary = approve/run,
   * secondary = reject. Requires the Bob IPC button patch (tools/patch-bob-buttons.mjs)
   * — without it Bob's IPC switch ignores these commandNames.
   *
   * We send a Bob task id as the command `data`: the patch presses ONLY the webview
   * instance whose `getCurrentTask().taskId` matches it (else the sole running instance),
   * so the press lands on the instance actually showing the prompt and never on an idle
   * one (an idle-sidebar press aborts a --new-tab task). If no instance owns the task,
   * the patch no-ops rather than guessing.
   *
   * `taskId` defaults to the bound root; pass an owned SUBTASK's id to press the instance
   * showing that subtask's prompt (an orchestrator's command ask), which is more precise than
   * relying on the patch's sole-runner fallback.
   */
  approve(taskId?: string): void {
    if (!this.active) return; // no dispatch in flight — don't press a stray button
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "PressPrimaryButton", data: taskId ?? this.active.ourTaskId },
    });
  }

  reject(taskId?: string): void {
    if (!this.active) return; // no dispatch in flight — don't press a stray button
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "PressSecondaryButton", data: taskId ?? this.active.ourTaskId },
    });
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
