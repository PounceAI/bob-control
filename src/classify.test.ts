import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseDecision, classifyCommand } from "./classify.js";

// Fake `claude` process: a child whose stdin.end(prompt) triggers the given
// stdout payload + exit code on the next tick (after listeners are attached).
function fakeSpawn(stdout: string, code = 0, stderr = "") {
  return (() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      end: () => {
        process.nextTick(() => {
          if (stdout) child.stdout.emit("data", Buffer.from(stdout));
          if (stderr) child.stderr.emit("data", Buffer.from(stderr));
          child.emit("close", code);
        });
      },
    };
    return child;
  }) as any;
}

// The parser is the safety-critical core: it must never throw and must default to
// a non-approving "ask" whenever the model's answer isn't an explicit decision.

test("parseDecision reads a clean JSON decision", () => {
  assert.deepEqual(parseDecision('{"decision":"approve","reason":"runs the test suite"}'), {
    decision: "approve",
    reason: "runs the test suite",
  });
  assert.equal(parseDecision('{"decision":"deny","reason":"rm -rf outside build"}').decision, "deny");
});

test("parseDecision tolerates surrounding prose and extracts the JSON", () => {
  assert.equal(parseDecision('Sure! {"decision":"approve","reason":"npm test"} hope that helps').decision, "approve");
});

test("parseDecision fails safe to 'ask' on garbage or unknown decisions", () => {
  assert.equal(parseDecision("not json at all").decision, "ask");
  assert.equal(parseDecision('{"decision":"maybe"}').decision, "ask");
  assert.equal(parseDecision("").decision, "ask");
  assert.equal(parseDecision('{"decision":').decision, "ask"); // truncated
});

test("classifyCommand fails safe to 'ask' on a non-OK HTTP response", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  const r = await classifyCommand("rm -rf /", { task: "t", cwd: "/repo" }, { apiKey: "k", fetchImpl });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /HTTP 500/);
});

test("classifyCommand fails safe to 'ask' when the transport throws", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const r = await classifyCommand("npm test", { task: "t", cwd: "/repo" }, { apiKey: "k", fetchImpl });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /network down/);
});

test("classifyCommand returns the model's parsed decision on success", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: '{"decision":"approve","reason":"safe build"}' }] }),
  })) as unknown as typeof fetch;
  const r = await classifyCommand("npm run build", { task: "t", cwd: "/repo" }, { apiKey: "k", fetchImpl });
  assert.deepEqual(r, { decision: "approve", reason: "safe build" });
});

test("cli backend unwraps the claude --output-format json envelope", async () => {
  const envelope = JSON.stringify({ type: "result", result: '{"decision":"approve","reason":"runs tests"}' });
  const r = await classifyCommand(
    "cargo test",
    { task: "t", cwd: "/repo" },
    { backend: "cli", spawnImpl: fakeSpawn(envelope, 0) },
  );
  assert.deepEqual(r, { decision: "approve", reason: "runs tests" });
});

test("cli backend fails safe to 'ask' on a non-zero exit", async () => {
  const r = await classifyCommand(
    "rm -rf /",
    { task: "t", cwd: "/repo" },
    { backend: "cli", spawnImpl: fakeSpawn("", 1, "not logged in") },
  );
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /exit 1/);
});

test("api backend without a key fails safe to 'ask'", async () => {
  const r = await classifyCommand("npm test", { task: "t", cwd: "/repo" }, { backend: "api" });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /API_KEY/);
});
