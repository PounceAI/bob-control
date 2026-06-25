// Shared in-process IPC test harness for the BobClient integration suites. Encodes Bob's wire
// protocol once — the "\f" delimiter, the {type:"TaskEvent",data:{eventName,payload}} envelope, the
// Ack/StartNewTask handshake — so it lives in one place. Real net pipe; events flush synchronously on
// StartNewTask, so assertions are timer-free.
import net from "node:net";
import os from "node:os";
import { BobClient, type TaskLifecycleEvent, type DispatchResult } from "./bob-ipc.js";

export const DELIM = "\f";

let counter = 0;
/** A unique pipe path per call (pid + counter), so parallel test files never collide. */
export function pipePath(prefix = "bobtest"): string {
  counter += 1;
  const name = `${prefix}-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `${os.tmpdir()}/${name}.sock`;
}

export const frame = (obj: unknown): string => JSON.stringify(obj) + DELIM;

export type TaskEventFrame = { type: "TaskEvent"; data: { eventName: string; payload: unknown } };
export const taskEvent = (eventName: string, payload: unknown): TaskEventFrame => ({
  type: "TaskEvent",
  data: { eventName, payload },
});

/** One chat message frame on a given task: { taskId, message: { say|ask, text, ts } }. */
export const msg = (taskId: string, m: Record<string, unknown>): TaskEventFrame =>
  taskEvent("message", [{ taskId, message: m }]);

export interface OnEventRec {
  name: string;
  say?: string;
  ask?: string;
  text?: string;
  taskId?: string;
  isRoot?: boolean;
}

/** A button press the client sent back over the pipe (PressPrimaryButton / PressSecondaryButton). */
export interface Press {
  cmd: string;
  target: unknown;
}

export interface RunResult {
  result: DispatchResult;
  /** Lifecycle events the defer-observer saw, each flagged isOwn. */
  seen: TaskLifecycleEvent[];
  /** Events the worker's onEvent gate callback received (root events + routed subtask command asks). */
  onEvents: OnEventRec[];
  /** Button presses the client sent (so a test can assert which task id was targeted). */
  presses: Press[];
}

export interface RunOptions {
  timeoutMs?: number;
  tokenCeiling?: number;
  turnCap?: number;
  /**
   * Called for each command ask (stands in for the permission gate). Omit to observe without pressing;
   * pass e.g. `(c, id) => c.approve(id)` to exercise the press path.
   */
  onCommand?: (client: BobClient, taskId: string | undefined) => void;
}

/**
 * Run one dispatch over a fresh pipe, flushing `events` on StartNewTask, and return what tests assert
 * on: the settled result, the observer's lifecycle events (with isOwn), the onEvent callbacks, and the
 * button presses the client sent back (captured by DELIM-splitting incoming frames).
 */
export async function runDispatch(events: TaskEventFrame[], opts: RunOptions = {}): Promise<RunResult> {
  const path = pipePath();
  const presses: Press[] = [];
  const server = net.createServer((sock) => {
    sock.write(frame({ type: "Ack", data: { clientId: "test" } }));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf(DELIM)) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!raw.trim()) continue;
        let m: { type?: string; data?: { data?: { commandName?: string; data?: unknown } } };
        try {
          m = JSON.parse(raw);
        } catch {
          continue;
        }
        const inner = m?.type === "message" ? m.data : (m as { data?: { commandName?: string; data?: unknown } });
        const cmd = inner?.data?.commandName;
        if (cmd === "StartNewTask") {
          for (const ev of events) sock.write(frame(ev));
        } else if (cmd === "PressPrimaryButton" || cmd === "PressSecondaryButton") {
          presses.push({ cmd, target: inner!.data!.data });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));

  const seen: TaskLifecycleEvent[] = [];
  const onEvents: OnEventRec[] = [];
  const client = new BobClient(path);
  client.onTaskEvent((ev) => seen.push(ev));
  try {
    const result = await client.dispatch({
      text: "dispatch",
      timeoutMs: opts.timeoutMs ?? 2000,
      tokenCeiling: opts.tokenCeiling,
      turnCap: opts.turnCap,
      onEvent: (name, { say, ask, text, taskId, isRoot }) => {
        onEvents.push({ name, say, ask, text, taskId, isRoot });
        if (ask === "command" && opts.onCommand) opts.onCommand(client, taskId);
      },
    });
    return { result, seen, onEvents, presses };
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Stand up a stub Bob over a real in-process pipe for non-dispatch query tests (e.g. GetWorkspace): Ack
 * on connect, then invoke `onGetWorkspace(sock)` for each GetWorkspace TaskCommand — write a reply with
 * `frame(taskEvent("workspaceInfo", {...}))`, or do nothing to emulate an unpatched Bob. Connects a
 * BobClient, runs `body`, tears both down. Keeps the wire protocol in this one harness, not the suites.
 */
export async function withStubBob(
  onGetWorkspace: (sock: net.Socket) => void,
  body: (client: BobClient) => Promise<void>,
): Promise<void> {
  const path = pipePath();
  const server = net.createServer((sock) => {
    sock.write(frame({ type: "Ack", data: { clientId: "test" } }));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf(DELIM)) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!raw.trim()) continue;
        let m: { type?: string; data?: { data?: { commandName?: string } } };
        try {
          m = JSON.parse(raw);
        } catch {
          continue;
        }
        const inner = m?.type === "message" ? m.data : (m as { data?: { commandName?: string } });
        if (inner?.data?.commandName === "GetWorkspace") onGetWorkspace(sock);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const client = new BobClient(path);
  try {
    await client.connect();
    await body(client);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Lookup helper: isOwn for the (taskId, eventName) lifecycle event the observer saw. */
export const ownOf =
  (seen: TaskLifecycleEvent[]) =>
  (id: string, name: string): boolean | undefined =>
    seen.find((e) => e.taskId === id && e.name === name)?.isOwn;
