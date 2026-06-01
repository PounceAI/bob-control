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

// --- parseDecision edge: a decision with no usable reason ---

test("parseDecision keeps the decision but substitutes '(no reason)' for a blank reason", () => {
  assert.deepEqual(parseDecision('{"decision":"approve","reason":"   "}'), {
    decision: "approve",
    reason: "(no reason)",
  });
  assert.deepEqual(parseDecision('{"decision":"deny"}'), { decision: "deny", reason: "(no reason)" });
});

// --- cli backend branches ---

// A child that never closes, so the timeout timer is the only thing that fires.
function fakeSpawnHang() {
  return (() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let killed = false;
    child.kill = () => {
      killed = true;
    };
    child._killed = () => killed;
    child.stdin = { end: () => {} }; // never emits close
    return child;
  }) as any;
}

// A child that emits an 'error' event (e.g. ENOENT) instead of closing.
function fakeSpawnErrorEvent(message: string) {
  return (() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      end: () => {
        process.nextTick(() => child.emit("error", new Error(message)));
      },
    };
    return child;
  }) as any;
}

test("cli backend rejects an invalid model name without spawning", async () => {
  let spawned = false;
  const spawnImpl = (() => {
    spawned = true;
    throw new Error("should not be called");
  }) as any;
  const r = await classifyCommand(
    "npm test",
    { task: "t", cwd: "/repo" },
    { backend: "cli", model: "bad model!", spawnImpl },
  );
  assert.equal(spawned, false);
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /invalid model name/);
});

test("cli backend fails safe to 'ask' when spawn throws synchronously", async () => {
  const spawnImpl = (() => {
    throw new Error("ENOENT claude");
  }) as any;
  const r = await classifyCommand("npm test", { task: "t", cwd: "/repo" }, { backend: "cli", spawnImpl });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /spawn failed.*ENOENT/);
});

test("cli backend fails safe to 'ask' on a child 'error' event", async () => {
  const r = await classifyCommand(
    "npm test",
    { task: "t", cwd: "/repo" },
    { backend: "cli", spawnImpl: fakeSpawnErrorEvent("spawn claude ENOENT") },
  );
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /cli error.*ENOENT/);
});

test("cli backend times out and kills the child", async () => {
  const spawnFactory = fakeSpawnHang();
  let child: any;
  const spawnImpl = ((...a: any[]) => (child = spawnFactory(...a))) as any;
  const r = await classifyCommand(
    "npm test",
    { task: "t", cwd: "/repo" },
    { backend: "cli", spawnImpl, timeoutMs: 10 },
  );
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /timeout/);
  assert.equal(child._killed(), true);
});

test("cli backend falls back to parsing raw stdout when the json envelope is malformed", async () => {
  // Non-JSON wrapper means JSON.parse(out) throws → it re-parses the raw text and
  // still finds the embedded decision.
  const r = await classifyCommand(
    "npm run build",
    { task: "t", cwd: "/repo" },
    { backend: "cli", spawnImpl: fakeSpawn('warming up... {"decision":"deny","reason":"writes outside repo"}', 0) },
  );
  assert.deepEqual(r, { decision: "deny", reason: "writes outside repo" });
});

// --- api backend request shape & model selection ---

test("api backend sends the documented request shape and default Haiku model", async () => {
  let captured: any;
  const fetchImpl = (async (_url: string, init: any) => {
    captured = { url: _url, body: JSON.parse(init.body), headers: init.headers };
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: '{"decision":"approve","reason":"ok"}' }] }),
    };
  }) as unknown as typeof fetch;
  await classifyCommand("npm test", { task: "ship it", cwd: "/repo" }, { backend: "api", apiKey: "k", fetchImpl });
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.body.model, "claude-haiku-4-5");
  assert.equal(captured.body.max_tokens, 100);
  assert.match(captured.body.system, /command-safety gate/);
  assert.match(captured.body.messages[0].content, /npm test/);
  assert.equal(captured.headers["x-api-key"], "k");
});

test("api backend honors a model override", async () => {
  let model: string | undefined;
  const fetchImpl = (async (_url: string, init: any) => {
    model = JSON.parse(init.body).model;
    return { ok: true, status: 200, json: async () => ({ content: [{ text: '{"decision":"deny","reason":"x"}' }] }) };
  }) as unknown as typeof fetch;
  await classifyCommand("rm x", { task: "t", cwd: "/repo" }, { backend: "api", apiKey: "k", model: "claude-opus-4-8", fetchImpl });
  assert.equal(model, "claude-opus-4-8");
});
