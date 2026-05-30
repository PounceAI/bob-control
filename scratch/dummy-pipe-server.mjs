#!/usr/bin/env node
// dummy-pipe-server.mjs — a named-pipe server that accepts connections and then
// sends NOTHING. Simulates a "wedged / half-up Bob IPC": the socket connects at
// the pipe level (so the worker does NOT get ENOENT and does NOT emit an `error`
// event), but no `Ack` ever arrives, so the worker's connect() never settles and
// it emits neither `connected` nor `error`. That silent hang is precisely the
// case the extension's 30s connect watchdog exists to rescue.
//
// Usage: node scratch/dummy-pipe-server.mjs [pipePath]
import net from "node:net";

const pipe = process.argv[2] || "\\\\.\\pipe\\bobtasks-watchdog-test";

const server = net.createServer((sock) => {
  console.log("[dummy] client connected — intentionally NOT sending an Ack (wedged-IPC simulation)");
  sock.on("error", () => {}); // ignore reset when the worker is killed
  sock.on("close", () => console.log("[dummy] client disconnected"));
});
server.on("error", (e) => {
  console.error(`[dummy] server error: ${e.message}`);
  process.exit(1);
});
server.listen(pipe, () => console.log(`[dummy] listening on ${pipe} (accepts connections, never Acks)`));

const shutdown = () => { try { server.close(); } catch {} process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
