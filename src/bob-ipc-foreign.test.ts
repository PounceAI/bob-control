import { test } from "node:test";
import assert from "node:assert/strict";
import { msg, runDispatch, taskEvent } from "./ipc-test-harness.js";

// Integration test over the shared in-process IPC harness (ipc-test-harness.ts): a concurrent Bob
// chat (a foreign task) emits its own completion_result and review findings while our dispatch is
// bound and running. Neither must be attributed to our task — the regression the foreign-task gating
// fixes.

test("a foreign chat's completion_result / findings are NOT attributed to our task", async () => {
  // Order matters: our task binds first, THEN the chat emits — so the chat is a known-foreign
  // task whose messages flow through handle() while we're correctly bound to our own task.
  const { result } = await runDispatch([
    taskEvent("taskCreated", [{ taskId: "ours" }]),
    taskEvent("taskStarted", [{ taskId: "ours" }]),
    msg("chat", { say: "completion_result", text: "CHAT ANSWER", ts: 1 }),
    msg("chat", {
      say: "tool",
      text: JSON.stringify({
        tool: "submit_review_findings",
        issues: [{ title: "chat finding", severity: "high", category: "x", description: "d" }],
      }),
      ts: 2,
    }),
    // Our task ends WITHOUT its own completion_result.
    taskEvent("taskAborted", [{ taskId: "ours" }]),
  ]);

  assert.equal(result.taskId, "ours"); // bound to our task, not the chat
  assert.equal(result.status, "aborted"); // settled on OUR terminal, not the chat's
  assert.equal(result.result, ""); // the chat's completion_result did NOT leak in
  assert.notEqual(result.lastText, "CHAT ANSWER"); // nor as diagnostic text
  assert.equal((result.reviewFindings ?? []).length, 0); // nor the chat's findings
});
