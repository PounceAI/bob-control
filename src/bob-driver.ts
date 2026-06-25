import type { DispatchCore, DispatchResult } from "./bob-ipc.js";

/**
 * The transport-agnostic contract the board-pull loop drives Bob through, so the loop doesn't care
 * which Bob it's talking to. Two implementations:
 *   - `BobClient` (Bob 1.x) — node-ipc named pipe (`ROO_CODE_IPC_SOCKET_PATH`).
 *   - the in-process driver (Bob 2.x) — `exports.startTask` + the `~/.bob/db/bob.db` task-store watch.
 *
 * Only the core start/wait/workspace surface lives here. Bob 1.x's live `TaskEvent` stream, button
 * presses (approve/reject), and `sendMessage` — the gate layer — have **no 2.x equivalent** (2.0
 * exposes no event stream), so they stay on `BobClient` and are wired only on the 1.x path. See
 * docs/bob-2-inprocess.md.
 */
export interface BobDriver {
  /** Establish the connection (1.x: open the pipe) / resolve the in-process handle (2.x: activate). */
  connect(timeoutMs?: number): Promise<void>;
  /** The workspace folder Bob has open, or null if unknowable. 1.x: IPC handshake; 2.x: the VS Code API. */
  queryWorkspace(timeoutMs?: number): Promise<string | null>;
  /**
   * Dispatch a task and resolve when it reaches a terminal state (the result carries how it ended).
   * Typed on `DispatchCore` (text/mode/config/newTab/timeoutMs) — the 1.x gate fields a `BobClient`
   * also takes (onEvent/idleMs/tokenCeiling/…) have no 2.x equivalent, so the seam doesn't promise them.
   */
  dispatch(opts: DispatchCore): Promise<DispatchResult>;
  /** Release held resources (1.x: the socket; 2.x: any DB watcher). */
  close(): void;
}
