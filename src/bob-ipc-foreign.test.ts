import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { BobClient } from "./bob-ipc.js";

// Integration test over a real in-process IPC pipe: a concurrent Bob chat (a foreign task)
// emits its own completion_result and review findings while our dispatch is bound and running.
// Neither must be attributed to our task — the regression the foreign-task gating fixes.

const DELIM = "\f";
let counter = 0;
function pipePath(): string {
  counter += 1;
  const name = `bobtest-${process.pid}-${counter}`;
  // Windows named pipe vs unix domain socket file.
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `${os.tmpdir()}/${name}.sock`;
}

const frame = (obj: unknown): string => JSON.stringify(obj) + DELIM;
const taskEvent = (eventName: string, payload: unknown) => ({ type: "TaskEvent", data: { eventName, payload } });

test("a foreign chat's completion_result / findings are NOT attributed to our task", async () => {
  const path = pipePath();

  // Order matters: our task binds first, THEN the chat emits — so the chat is a known-foreign
  // task whose messages flow through handle() while we're correctly bound to our own task.
  const events = [
    taskEvent("taskCreated", [{ taskId: "ours" }]),
    taskEvent("taskStarted", [{ taskId: "ours" }]),
    taskEvent("message", [{ taskId: "chat", message: { say: "completion_result", text: "CHAT ANSWER", ts: 1 } }]),
    taskEvent("message", [
      {
        taskId: "chat",
        message: {
          say: "tool",
          text: JSON.stringify({
            tool: "submit_review_findings",
            issues: [{ title: "chat finding", severity: "high", category: "x", description: "d" }],
          }),
          ts: 2,
        },
      },
    ]),
    // Our task ends WITHOUT its own completion_result.
    taskEvent("taskAborted", [{ taskId: "ours" }]),
  ];

  const server = net.createServer((sock) => {
    sock.write(frame({ type: "Ack", data: { clientId: "test" } }));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("StartNewTask")) {
        buf = "";
        for (const ev of events) sock.write(frame(ev));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));

  const client = new BobClient(path);
  try {
    const result = await client.dispatch({ text: "do the thing", timeoutMs: 2000 });
    assert.equal(result.taskId, "ours"); // bound to our task, not the chat
    assert.equal(result.status, "aborted"); // settled on OUR terminal, not the chat's
    assert.equal(result.result, ""); // the chat's completion_result did NOT leak in
    assert.notEqual(result.lastText, "CHAT ANSWER"); // nor as diagnostic text
    assert.equal((result.reviewFindings ?? []).length, 0); // nor the chat's findings
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
