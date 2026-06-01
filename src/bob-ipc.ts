import net from "node:net";

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
  onEvent?: (name: string, detail: { say?: string; ask?: string; text?: string; partial?: boolean }) => void;
}

export interface DispatchResult {
  taskId: string | null;
  /** Genuine attempt_completion text Bob emitted, or "" if it never did. */
  result: string;
  /** Last non-empty streamed say text (e.g. a tool call) — diagnostics only, NOT a completion. */
  lastText: string;
  status: "completed" | "aborted" | "timeout";
}

export interface TaskLifecycleEvent {
  /** e.g. taskCreated | taskStarted | taskCompleted | taskAborted */
  name: string;
  taskId: string;
  /** True if this event belongs to the worker's own in-flight dispatch. */
  isOwn: boolean;
}

interface ActiveDispatch {
  ourTaskId: string | null;
  lastCompletion: string;
  lastText: string;
  settle: (r: DispatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onEvent?: DispatchOptions["onEvent"];
  done: boolean;
}

/** Default to the node-ipc-mangled doubled pipe that Bob actually registers. */
export function resolvePipe(p?: string): string {
  return p ?? process.env.BOB_IPC_PIPE ?? "\\\\.\\pipe\\pipe\\bob-ipc";
}

export class BobClient {
  private sock: net.Socket | null = null;
  private buffer = "";
  private clientId: string | null = null;
  private active: ActiveDispatch | null = null;
  private connectSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private observer: ((ev: TaskLifecycleEvent) => void) | null = null;
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

  /** Connect and resolve once the server's Ack arrives. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectSettle = { resolve, reject };
      this.open(this.pipe, false);
    });
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
          this.open(doubled, true);
          return;
        }
      }
      this.connectSettle?.reject(err);
      this.connectSettle = null;
    });
    sock.on("close", () => {
      // If a task was mid-flight, surface it as aborted rather than hang.
      this.finish("aborted");
    });
  }

  private send(obj: unknown): void {
    this.sock?.write(JSON.stringify({ type: "message", data: obj }) + DELIM);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
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
      this.connectSettle?.resolve();
      this.connectSettle = null;
      return;
    }

    if (msg.type === "TaskEvent") {
      const ev = msg.data ?? {};
      const name: string = ev.eventName ?? ev.event ?? ev.type ?? "event";
      const payload = ev.payload ?? ev.data ?? ev;
      const taskId =
        payload?.taskId ??
        (Array.isArray(payload)
          ? typeof payload[0] === "string"
            ? payload[0]
            : payload[0]?.taskId
          : undefined);

      // Active-dispatch handling: bind id, capture result, settle on terminal.
      if (this.active) {
        if (!this.active.ourTaskId && taskId && /taskCreated|taskStarted/i.test(name)) {
          this.active.ourTaskId = taskId;
        }
        // Extract any chat message (say/ask + text) from the payload.
        const arr = Array.isArray(payload) ? payload : [payload];
        const cline = arr.map((p: any) => p?.message ?? p).find((m: any) => m && (m.text || m.say || m.ask));
        if (cline) {
          const ask: string | undefined = cline.ask;
          const say: string | undefined = cline.say ?? cline.ask;
          const text: string = String(cline.text ?? "");
          if (say === "completion_result" && text.trim()) this.active.lastCompletion = text;
          else if (text.trim()) this.active.lastText = text;
          this.active.onEvent?.(name, { say, ask, text, partial: !!cline.partial });
        } else {
          this.active.onEvent?.(name, {});
        }
      }

      // Report every lifecycle event (even while idle), flagging whether it's
      // our own dispatch so callers can detect external chat activity.
      if (taskId && this.observer && /taskCreated|taskStarted|taskCompleted|taskAborted/i.test(name)) {
        const isOwn = !!(this.active && this.active.ourTaskId && taskId === this.active.ourTaskId);
        this.observer({ name, taskId, isOwn });
      }

      // Only settle for our task; ignore a prior task aborting on tab reuse.
      const terminal = /taskCompleted|taskAborted/i.test(name);
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
    this.active = null;
    a.settle({
      taskId: a.ourTaskId,
      // Only a genuine completion_result counts as the result; the trailing
      // streamed text (e.g. an updateTodoList tool-say) is diagnostics only, so a
      // timeout with no completion_result yields result:"" → worker parks blocked.
      result: a.lastCompletion,
      lastText: a.lastText,
      status,
    });
  }

  /** Dispatch one task and resolve when it completes (or aborts / times out). */
  dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    if (!this.sock) throw new Error("BobClient.dispatch called before connect()");
    if (this.active) throw new Error("BobClient is busy — dispatch tasks sequentially");
    const timeoutMs = opts.timeoutMs ?? 300_000;
    return new Promise<DispatchResult>((resolve) => {
      const active: ActiveDispatch = {
        ourTaskId: null,
        lastCompletion: "",
        lastText: "",
        settle: resolve,
        onEvent: opts.onEvent,
        done: false,
        timer: setTimeout(() => this.finish("timeout"), timeoutMs),
      };
      active.timer.unref?.();
      this.active = active;
      try {
        this.send({
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
      } catch {
        // Socket write failed: settle now instead of waiting out the timeout.
        this.finish("aborted");
      }
    });
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
   */
  approve(): void {
    if (!this.active) return; // no dispatch in flight — don't press a stray button
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "PressPrimaryButton", data: null },
    });
  }

  reject(): void {
    if (!this.active) return; // no dispatch in flight — don't press a stray button
    this.send({
      type: "TaskCommand",
      origin: "client",
      clientId: this.clientId,
      data: { commandName: "PressSecondaryButton", data: null },
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
    try {
      this.sock?.end();
    } catch {
      /* ignore */
    }
    this.sock = null;
  }
}
