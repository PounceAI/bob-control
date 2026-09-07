// ACP transport: newline-delimited JSON-RPC 2.0 over the agent's stdio, both directions carrying requests (the
// agent asks us for permission decisions). Inbound requests route to handlers, unknown methods get -32601, a
// non-JSON stdout line is skipped. The transport is injected: a child process, or an in-memory pair in tests.
import type { Readable, Writable } from "node:stream";

/** JSON-RPC error surfaced to a request's caller. `code` is the peer's (e.g. -32000 = auth required). */
export class AcpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

/** The byte pipe to the agent. `onExit` fires once when the peer goes away (stdout end or process exit). */
export interface AcpTransport {
  stdin: Writable;
  stdout: Readable;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

export type RequestHandler = (params: any) => Promise<unknown> | unknown;
export type NotificationHandler = (params: any) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
}

// A peer that never sends a newline must not grow the buffer without bound.
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private closeListeners: ((code: number | null) => void)[] = [];
  private buffer = "";
  private _closed = false;
  private exitCode: number | null | undefined;

  constructor(
    private readonly transport: AcpTransport,
    private readonly log: (msg: string) => void = () => {},
  ) {
    transport.stdout.on("data", (chunk: Buffer | string) => this.onData(chunk));
    transport.stdout.on("end", () => this.onExit(this.exitCode ?? null));
    transport.stdout.on("error", () => this.onExit(this.exitCode ?? null));
    transport.onExit((code) => {
      this.exitCode = code;
      this.onExit(code);
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Fires once, when the peer is gone (whether we closed it or it died). */
  onClose(fn: (code: number | null) => void): void {
    if (this._closed) fn(this.exitCode ?? null);
    else this.closeListeners.push(fn);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request; resolves with the peer's `result`, rejects with AcpRpcError on `error`, or with a
   *  plain Error if the peer dies / the optional timeout elapses first. */
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this._closed) return Promise.reject(new Error(`ACP connection closed (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject, method };
      if (timeoutMs && timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new Error(`ACP write failed (${method}) — peer gone`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** End our side and kill the peer. Pending requests reject via onExit. */
  close(): void {
    try {
      this.transport.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      this.transport.kill();
    } catch {
      /* already gone */
    }
    this.onExit(this.exitCode ?? null);
  }

  private write(msg: unknown): boolean {
    if (this._closed) return false;
    try {
      this.transport.stdin.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      const last = this.buffer.lastIndexOf("\n");
      this.buffer = last === -1 ? "" : this.buffer.slice(last + 1);
    }
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const raw = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!raw) continue;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        this.log(`acp: skipped non-JSON line: ${raw.slice(0, 120)}`);
        continue;
      }
      if (msg && typeof msg === "object") this.handle(msg);
    }
  }

  private handle(msg: any): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (hasId) this.handleRequest(msg.id, msg.method, msg.params);
      else this.notificationHandlers.get(msg.method)?.(msg.params);
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error ?? {};
        p.reject(new AcpRpcError(typeof e.code === "number" ? e.code : -1, String(e.message ?? "error"), e.data));
      } else p.resolve(msg.result);
    }
  }

  private handleRequest(id: unknown, method: string, params: unknown): void {
    const h = this.requestHandlers.get(method);
    if (!h) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    Promise.resolve()
      .then(() => h(params))
      .then(
        (result) => this.write({ jsonrpc: "2.0", id, result: result ?? {} }),
        (err: Error) =>
          this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: err?.message ?? String(err) } }),
      );
  }

  private onExit(code: number | null): void {
    if (this._closed) return;
    this._closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`ACP peer exited (code ${code ?? "signal"}) during ${p.method}`));
    }
    this.pending.clear();
    for (const fn of this.closeListeners) fn(code);
    this.closeListeners = [];
  }
}
