import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AcpConnection, AcpRpcError, type AcpTransport } from "./acp-client.js";

// An in-memory peer: what we write to `stdin` it reads line by line; what it writes to `stdout` we read.
function pair(): {
  transport: AcpTransport;
  peerLines: string[];
  peerWrite: (msg: unknown) => void;
  onPeerLine: (fn: (msg: any) => void) => void;
  exit: (code: number | null) => void;
  killed: () => boolean;
} {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  const peerLines: string[] = [];
  const listeners: ((msg: any) => void)[] = [];
  let buf = "";
  toPeer.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      peerLines.push(line);
      const msg = JSON.parse(line);
      for (const l of listeners) l(msg);
    }
  });
  let exitFn: ((code: number | null) => void) | null = null;
  let killed = false;
  return {
    transport: {
      stdin: toPeer,
      stdout: fromPeer,
      onExit: (fn) => (exitFn = fn),
      kill: () => {
        killed = true;
      },
    },
    peerLines,
    peerWrite: (msg) => fromPeer.write(JSON.stringify(msg) + "\n"),
    onPeerLine: (fn) => listeners.push(fn),
    exit: (code) => exitFn?.(code),
    killed: () => killed,
  };
}

test("request resolves with the peer's result and rejects with AcpRpcError on error", async () => {
  const p = pair();
  const conn = new AcpConnection(p.transport);
  p.onPeerLine((m) => {
    if (m.method === "initialize") p.peerWrite({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
    if (m.method === "session/new")
      p.peerWrite({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required" } });
  });
  assert.deepEqual(await conn.request("initialize", { protocolVersion: 1 }), { protocolVersion: 1 });
  await assert.rejects(conn.request("session/new", {}), (e: unknown) => e instanceof AcpRpcError && e.code === -32000);
  assert.equal(JSON.parse(p.peerLines[0]).jsonrpc, "2.0");
});

test("inbound requests route to handlers; unknown methods get -32601; notifications route too", async () => {
  const p = pair();
  const conn = new AcpConnection(p.transport);
  const updates: unknown[] = [];
  conn.onNotification("session/update", (params) => updates.push(params));
  conn.onRequest("session/request_permission", async (params) => ({
    outcome: { outcome: "selected", optionId: params.pick },
  }));
  p.peerWrite({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
  p.peerWrite({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { pick: "allow" } });
  p.peerWrite({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: {} });
  p.peerWrite({ jsonrpc: "2.0", method: "session/update", params: { n: 2 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(updates, [{ n: 1 }, { n: 2 }]);
  const replies = p.peerLines.map((l) => JSON.parse(l));
  assert.deepEqual(replies.find((r) => r.id === 7)?.result, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.equal(replies.find((r) => r.id === 8)?.error?.code, -32601);
});

test("a peer exit rejects every pending request, fires onClose once, and later requests fail fast", async () => {
  const p = pair();
  const conn = new AcpConnection(p.transport);
  let closes = 0;
  conn.onClose(() => closes++);
  const pending = conn.request("session/prompt", {});
  p.exit(1);
  await assert.rejects(pending, /exited \(code 1\) during session\/prompt/);
  assert.equal(conn.closed, true);
  await assert.rejects(conn.request("x"), /closed/);
  conn.close();
  assert.equal(closes, 1);
});

test("a request timeout rejects without waiting on the peer; non-JSON lines are skipped", async () => {
  const p = pair();
  const skipped: string[] = [];
  const conn = new AcpConnection(p.transport, (m) => skipped.push(m));
  (p.transport.stdout as PassThrough).write("Starting up...\n");
  await assert.rejects(conn.request("initialize", {}, 15), /timed out after 15ms/);
  assert.equal(skipped.length, 1);
  p.onPeerLine((m) => p.peerWrite({ jsonrpc: "2.0", id: m.id, result: "ok" }));
  assert.equal(await conn.request("later"), "ok");
  conn.close();
  assert.equal(p.killed(), true);
});
