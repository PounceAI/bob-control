import type { DispatchCore, DispatchOptions, DispatchResult, TaskLifecycleEvent } from "./bob-ipc.js";

/**
 * The transport-agnostic contract the board-pull loop drives Bob through, so the loop doesn't care
 * which Bob it's talking to. Three implementations:
 *   - `BobClient` (Bob 1.x) — node-ipc named pipe (`ROO_CODE_IPC_SOCKET_PATH`).
 *   - the in-process driver (Bob 2.x IDE) — `exports.startTask` + the `~/.bob/db/bob.db` task-store watch.
 *   - `AcpDriver` (Bob Shell 2.x) — `bob acp`, the Agent Client Protocol over a child process's stdio.
 *
 * Only the core start/wait/workspace surface lives here. The gate surface (event stream, approve/reject,
 * sendMessage, cancel) is `WorkerClient` below: the 1.x pipe and the ACP driver have it, the in-process
 * driver does not (2.0's exports expose no event stream). See docs/bob-2-inprocess.md.
 */
export interface BobDriver {
  /** Establish the connection (1.x: open the pipe) / resolve the in-process handle (2.x: activate). */
  connect(timeoutMs?: number): Promise<void>;
  /** The workspace folder Bob has open, or null if unknowable. 1.x: IPC handshake; 2.x: the VS Code API. */
  queryWorkspace(timeoutMs?: number): Promise<string | null>;
  /**
   * Dispatch a task and resolve when it reaches a terminal state (the result carries how it ended).
   * Typed on `DispatchCore` (text/mode/config/newTab/timeoutMs) — the 1.x gate fields a `BobClient`
   * also takes (onEvent/idleMs/tokenCeiling/…) have no in-process equivalent, so the seam doesn't promise them.
   */
  dispatch(opts: DispatchCore): Promise<DispatchResult>;
  /** Release held resources (1.x: the socket; 2.x: any DB watcher). */
  close(): void;
  /**
   * Defer-while-chatting signal: true if the user appears to be actively using Bob's chat right now, so the
   * loop should pause dispatch rather than open a task over a live conversation. Optional — only the 2.x
   * in-process driver implements it (a bob.db poll); the 1.x worker derives defer from its own IPC event
   * stream, so `BobClient` leaves it undefined and the loop skips the gate.
   */
  externalActivity?(idleMs: number): Promise<boolean>;
}

/** The surface worker.ts drives: the core plus the gate layer. A blocking prompt reaches the worker as an `ask`
 *  on `onEvent`; the gates answer through approve/reject, sendMessage and cancel (webview presses on the pipe,
 *  `session/request_permission` replies and the next `session/prompt` over ACP). */
export interface WorkerClient extends BobDriver {
  dispatch(opts: DispatchOptions): Promise<DispatchResult>;
  /** Approve the pending permission prompt (optionally the one raised by `taskId`). */
  approve(taskId?: string): void;
  /** Reject the pending permission prompt. */
  reject(taskId?: string): void;
  /** Answer a pending followup question / inject a message into the running task. */
  sendMessage(text: string): void;
  /** Cancel a running task by id. */
  cancel(taskId: string): void;
  /** Cancel the in-flight dispatch's task, if any. */
  cancelActive(): void;
  /** Observe task lifecycle events (own and foreign) — the defer-while-chatting input. */
  onTaskEvent(fn: (ev: TaskLifecycleEvent) => void): void;
}
