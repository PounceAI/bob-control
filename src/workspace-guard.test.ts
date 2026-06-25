import { test } from "node:test";
import assert from "node:assert/strict";
import { BobClient } from "./bob-ipc.js";
import { workspaceVerdict, workspaceMismatchQuestion } from "./workspace-guard.js";
import { frame, pipePath, taskEvent, withStubBob } from "./ipc-test-harness.js";

// Layer-2 wrong-Bob guard. The verdict/message are pure; queryWorkspace is exercised over a real
// in-process pipe (withStubBob = a stub Bob that answers GetWorkspace) so the request→workspaceInfo
// round-trip, the malformed-reply guard, and the unpatched-Bob timeout are all covered without mocks.
// The negative cases assert HOW null was reached (timing), so a dead reply path can't pass by timing out.

test("workspaceVerdict: null reported is unverifiable → no block (layer-1 still governs)", () => {
  assert.equal(workspaceVerdict(null, "C:\\repos\\app"), null);
});

test("workspaceVerdict: same folder (different spelling) → no mismatch", () => {
  assert.equal(workspaceVerdict("c:/repos/app/", "C:\\repos\\app"), null);
});

test("workspaceVerdict: different folder → mismatch carries both paths", () => {
  const v = workspaceVerdict("C:\\repos\\other", "C:\\repos\\app");
  assert.deepEqual(v, { reported: "C:\\repos\\other", expected: "C:\\repos\\app" });
});

test("workspaceMismatchQuestion names the hit instance, the expected one, and the fix", () => {
  const q = workspaceMismatchQuestion({ reported: "C:\\repos\\other", expected: "C:\\repos\\app" });
  assert.match(q, /WRONG Bob/);
  assert.ok(q.includes("C:\\repos\\other"));
  assert.ok(q.includes("C:\\repos\\app"));
  // Self-contained fix hint (no reference to a gitignored design doc).
  assert.match(q, /ROO_CODE_IPC_SOCKET_PATH|bobTasks\.pipe/);
});

test("queryWorkspace returns the folder a patched Bob reports", async () => {
  await withStubBob(
    (sock) => sock.write(frame(taskEvent("workspaceInfo", { fsPath: "C:\\repos\\app", pid: 123 }))),
    async (client) => {
      assert.equal(await client.queryWorkspace(2000), "C:\\repos\\app");
    },
  );
});

test("queryWorkspace consumes a malformed reply (blank fsPath → null) WITHOUT waiting for the timeout", async () => {
  await withStubBob(
    (sock) => sock.write(frame(taskEvent("workspaceInfo", { fsPath: "" }))),
    async (client) => {
      const t0 = Date.now();
      // Generous timeout: a reply-driven null must beat it by far, so a dead reply path (which would
      // only ever time out) fails this rather than passing as if it handled the malformed frame.
      assert.equal(await client.queryWorkspace(5000), null);
      assert.ok(Date.now() - t0 < 1000, "resolved from the reply, not the 5s timeout");
    },
  );
});

test("queryWorkspace resolves null promptly when the pipe drops mid-handshake (not stranded on the timer)", async () => {
  await withStubBob(
    (sock) => sock.destroy(), // pipe drops after GetWorkspace lands, before any reply
    async (client) => {
      const t0 = Date.now();
      // The socket close must settle the waiter; without that, it would hang to the 5s timeout — and
      // at worker startup (no other live handle) the unref'd timer wouldn't even keep the loop alive.
      assert.equal(await client.queryWorkspace(5000), null);
      assert.ok(Date.now() - t0 < 1000, "settled by the socket drop, not the 5s timeout");
    },
  );
});

test("queryWorkspace times out to null when Bob never answers (unpatched bundle)", async () => {
  await withStubBob(
    () => {
      /* unpatched Bob drops GetWorkspace — no reply */
    },
    async (client) => {
      const t0 = Date.now();
      assert.equal(await client.queryWorkspace(150), null);
      assert.ok(Date.now() - t0 >= 100, "waited out the timeout (didn't resolve instantly)");
    },
  );
});

test("queryWorkspace short-circuits to null before connecting (no socket, no timer armed)", async () => {
  const client = new BobClient(pipePath());
  const t0 = Date.now();
  assert.equal(await client.queryWorkspace(5000), null);
  assert.ok(Date.now() - t0 < 1000, "returned immediately, not via the 5s timer");
});
