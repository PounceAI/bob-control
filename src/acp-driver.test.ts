import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { AcpTransport } from "./acp-client.js";
import {
  AcpDriver,
  classifyPermission,
  parseFollowupArgs,
  permissionPolicyFor,
  resolveBobLaunch,
  selectOption,
} from "./acp-driver.js";
import type { WatchdogTimer } from "./watchdog.js";

// The ACP driver against a scripted in-memory Bob Shell: the agent side of the protocol is faked over
// PassThrough streams, so every path (mode select, permission asks, followups, cancel, budget, peer death)
// runs offline and deterministically.

interface FakeAgentScript {
  modes?: unknown;
  sessionNewError?: { code: number; message: string };
  onPrompt: (params: any, agent: FakeAgent) => Promise<{ stopReason: string }>;
}

class FakeAgent {
  readonly transport: AcpTransport;
  readonly received: any[] = [];
  readonly setModes: string[] = [];
  cancelled = false;
  private cancelWaiters: (() => void)[] = [];
  private toClient = new PassThrough();
  private fromClient = new PassThrough();
  private exitFn: ((code: number | null) => void) | null = null;
  private buf = "";
  private nextId = 100;
  private pending = new Map<number, (v: any) => void>();
  killed = false;

  constructor(private script: FakeAgentScript) {
    this.transport = {
      stdin: this.fromClient,
      stdout: this.toClient,
      onExit: (fn) => (this.exitFn = fn),
      kill: () => {
        this.killed = true;
      },
    };
    this.fromClient.on("data", (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) void this.handle(JSON.parse(line));
      }
    });
  }

  send(msg: unknown): void {
    this.toClient.write(JSON.stringify(msg) + "\n");
  }
  update(sessionId: string, update: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  /** Agent → client request; resolves with the client's result. */
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  permission(sessionId: string, toolCall: Record<string, unknown>): Promise<any> {
    return this.request("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
      ],
    });
  }
  /** Resolves once the client sends session/cancel. */
  onCancel(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise((r) => this.cancelWaiters.push(r));
  }
  exit(code: number | null): void {
    this.toClient.end();
    this.exitFn?.(code);
  }

  private async handle(msg: any): Promise<void> {
    this.received.push(msg);
    if (msg.id !== undefined && msg.method === undefined) {
      this.pending.get(msg.id)?.(msg.error ?? msg.result);
      this.pending.delete(msg.id);
      return;
    }
    const reply = (result: unknown) => this.send({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        reply({ protocolVersion: 1, agentInfo: { name: "bob-shell", version: "test" } });
        return;
      case "session/new":
        if (this.script.sessionNewError) this.send({ jsonrpc: "2.0", id: msg.id, error: this.script.sessionNewError });
        else reply({ sessionId: "s1", ...(this.script.modes !== undefined ? { modes: this.script.modes } : {}) });
        return;
      case "session/set_mode":
        this.setModes.push(msg.params.modeId);
        reply({});
        return;
      case "session/prompt":
        reply(await this.script.onPrompt(msg.params, this));
        return;
      case "session/cancel":
        this.cancelled = true;
        for (const w of this.cancelWaiters) w();
        this.cancelWaiters = [];
        return;
      default:
        return;
    }
  }
}

const MODES = {
  currentModeId: "agent",
  availableModes: [{ id: "agent" }, { id: "ask" }, { id: "plan" }, { id: "review" }],
};

function driverFor(agent: FakeAgent, extra: Partial<ConstructorParameters<typeof AcpDriver>[0]> = {}): AcpDriver {
  return new AcpDriver({ cwd: "C:\\ws", spawn: () => agent.transport, warn: () => {}, cancelGraceMs: 20, ...extra });
}

function manualTimer(): WatchdogTimer & { fire: () => void } {
  let cb: (() => void) | null = null;
  return {
    set: (fn) => {
      cb = fn;
      return 1;
    },
    clear: () => {
      cb = null;
    },
    fire: () => cb?.(),
  };
}

test("happy path: sets the requested mode, streams progress, captures attempt_completion as the result", async () => {
  const agent = new FakeAgent({
    modes: MODES,
    onPrompt: async (params, ag) => {
      const sid = params.sessionId;
      ag.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking…" } });
      ag.update(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        kind: "read",
        status: "pending",
      });
      ag.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      ag.update(sid, { sessionUpdate: "usage_update", inputTokens: 500, outputTokens: 40 });
      ag.update(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "attempt_completion",
        kind: "other",
        rawInput: { result: "Done: reviewed 3 files" },
      });
      return { stopReason: "end_turn" };
    },
  });
  const events: string[] = [];
  const lifecycle: string[] = [];
  const d = driverFor(agent);
  d.onTaskEvent((ev) => lifecycle.push(`${ev.name}:${ev.isOwn}`));
  const res = await d.dispatch({
    text: "Task #1: review",
    mode: "review",
    onEvent: (name, det) => events.push(`${name}/${det.say ?? det.ask ?? ""}`),
  });
  assert.equal(res.status, "completed");
  assert.equal(res.result, "Done: reviewed 3 files");
  assert.equal(res.taskId, "s1");
  assert.equal(res.tokensUsed, 40);
  assert.equal(res.turns, 1);
  assert.deepEqual(agent.setModes, ["review"]);
  assert.equal(agent.received.find((m) => m.method === "session/prompt")?.params.prompt[0].text, "Task #1: review");
  assert.ok(events.includes("message/text") && events.includes("tool/tool"));
  assert.deepEqual(lifecycle, ["taskCreated:true", "taskCompleted:true"]);
  await new Promise((r) => setImmediate(r)); // the process is released a tick after settle
  assert.equal(agent.killed, true);
});

test("a mode the session doesn't offer downgrades (with a warning) instead of failing; 1.x slugs map to 2.x", async () => {
  const warns: string[] = [];
  const agent = new FakeAgent({ modes: MODES, onPrompt: async () => ({ stopReason: "end_turn" }) });
  const d = driverFor(agent, { warn: (m) => warns.push(m) });
  const res = await d.dispatch({ text: "x", mode: "devsecops" });
  assert.equal(res.status, "completed");
  assert.deepEqual(agent.setModes, []); // fallback for a non-read-only custom mode is agent = current → no switch
  assert.match(warns[0], /'devsecops' is not offered/);
  const agent2 = new FakeAgent({ modes: MODES, onPrompt: async () => ({ stopReason: "end_turn" }) });
  await driverFor(agent2).dispatch({ text: "x", mode: "code" });
  assert.deepEqual(agent2.setModes, []); // code → agent, already current
});

test("without an attempt_completion the turn's own message text is the result", async () => {
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      ag.update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PO" } });
      ag.update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NG" } });
      return { stopReason: "end_turn" };
    },
  });
  const res = await driverFor(agent).dispatch({ text: "ping" });
  assert.equal(res.result, "PONG");
  assert.equal(res.status, "completed");
});

test("a command permission prompt reaches the gates as ask:'command' and approve()/reject() answer it", async () => {
  let outcome: any = null;
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      outcome = await ag.permission(p.sessionId, {
        toolCallId: "c1",
        title: "execute_command",
        kind: "execute",
        rawInput: { command: "npm test" },
      });
      return { stopReason: "end_turn" };
    },
  });
  const d = driverFor(agent);
  const asks: { ask?: string; text?: string }[] = [];
  const res = await d.dispatch({
    text: "run tests",
    onEvent: (_n, det) => {
      if (det.ask) {
        asks.push({ ask: det.ask, text: det.text });
        d.approve(det.taskId);
      }
    },
  });
  assert.deepEqual(asks, [{ ask: "command", text: "npm test" }]);
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.equal(res.status, "completed");

  let outcome2: any = null;
  const agent2 = new FakeAgent({
    onPrompt: async (p, ag) => {
      outcome2 = await ag.permission(p.sessionId, {
        toolCallId: "c2",
        kind: "execute",
        rawInput: { command: "rm -rf /" },
      });
      return { stopReason: "end_turn" };
    },
  });
  const d2 = driverFor(agent2);
  await d2.dispatch({ text: "x", onEvent: (_n, det) => det.ask && d2.reject() });
  assert.deepEqual(outcome2, { outcome: { outcome: "selected", optionId: "reject" } });
});

test("the permission policy settles non-command tools without a gate; a switch_mode always goes to the gate", async () => {
  const outcomes: any[] = [];
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      outcomes.push(
        await ag.permission(p.sessionId, {
          toolCallId: "w1",
          title: "write_file",
          kind: "edit",
          rawInput: { path: "a.ts" },
        }),
      );
      outcomes.push(
        await ag.permission(p.sessionId, {
          toolCallId: "m1",
          title: "switch_mode",
          kind: "switch_mode",
          rawInput: { mode_id: "review" },
        }),
      );
      outcomes.push(
        await ag.permission(p.sessionId, { toolCallId: "x1", title: "some_mcp_tool", kind: "other", rawInput: {} }),
      );
      return { stopReason: "end_turn" };
    },
  });
  const d = driverFor(agent);
  const asks: string[] = [];
  await d.dispatch({
    text: "x",
    permissionPolicy: permissionPolicyFor({ alwaysAllowWrite: true, alwaysAllowMcp: false, alwaysAllowBrowser: false }),
    onEvent: (_n, det) => {
      if (det.ask) {
        asks.push(`${det.ask}:${det.text}`);
        d.reject();
      }
    },
  });
  assert.equal(outcomes[0].outcome.optionId, "allow"); // edit auto-allowed by the profile
  assert.equal(outcomes[1].outcome.optionId, "reject"); // the (test) mode-switch gate rejected
  assert.equal(outcomes[2].outcome.optionId, "reject"); // MCP not allowed → asked → gate rejected
  assert.deepEqual(asks, [
    `tool:${JSON.stringify({ tool: "switchMode", mode: "review", reason: "" })}`,
    `tool:${JSON.stringify({ tool: "some_mcp_tool", kind: "other" })}`,
  ]);
});

test("a followup question yields the turn as ask:'followup'; sendMessage answers it on the same session", async () => {
  const prompts: string[] = [];
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      prompts.push(p.prompt[0].text);
      if (prompts.length === 1) {
        ag.update(p.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "q1",
          title: "ask_followup_question",
          kind: "other",
          rawInput: { question: "Which color?", follow_up: ["red", "blue"] },
        });
        return { stopReason: "end_turn" };
      }
      ag.update(p.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "d1",
        title: "attempt_completion",
        rawInput: { result: `Chose ${p.prompt[0].text}` },
      });
      return { stopReason: "end_turn" };
    },
  });
  const d = driverFor(agent);
  const asks: string[] = [];
  const res = await d.dispatch({
    text: "pick",
    isAnswerableAsk: (ask) => ask === "followup",
    onEvent: (_n, det) => {
      if (det.ask === "followup") {
        asks.push(det.text ?? "");
        setTimeout(() => d.sendMessage("blue"), 5);
      }
    },
  });
  assert.deepEqual(prompts, ["pick", "blue"]);
  assert.deepEqual(JSON.parse(asks[0]), { question: "Which color?", suggest: [{ answer: "red" }, { answer: "blue" }] });
  assert.equal(res.status, "completed");
  assert.equal(res.result, "Chose blue");
});

test("an unauthenticated Bob Shell aborts the dispatch with an actionable message; connect() surfaces it too", async () => {
  const mk = () =>
    new FakeAgent({
      sessionNewError: { code: -32000, message: "Authentication required" },
      onPrompt: async () => ({ stopReason: "end_turn" }),
    });
  const res = await driverFor(mk()).dispatch({ text: "x" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /authentication required.*BOB_API_KEY/i);
  await assert.rejects(driverFor(mk()).connect(), /authentication required/i);
});

test("the idle watchdog cancels a wedged turn and settles 'idle' with the pending ask", async () => {
  const timer = manualTimer();
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      void ag.permission(p.sessionId, { toolCallId: "c1", kind: "execute", rawInput: { command: "sudo rm -rf x" } });
      await ag.onCancel();
      return { stopReason: "cancelled" };
    },
  });
  const d = driverFor(agent, { timer });
  const p = d.dispatch({
    text: "x",
    idleMs: 1000,
    blockedAskGraceMs: 100,
    onEvent: () => setTimeout(() => timer.fire(), 5),
  });
  const res = await p;
  assert.equal(res.status, "idle");
  assert.equal(res.pendingAsk, "command");
  assert.equal(res.pendingAskText, "sudo rm -rf x");
  assert.equal(agent.cancelled, true);
  await new Promise((r) => setTimeout(r, 10));
  // The parked permission request was answered (cancelled), not left dangling.
  const permReply = agent.received.find((m) => m.id === 100 && m.method === undefined);
  assert.deepEqual(permReply?.result, { outcome: { outcome: "cancelled" } });
});

test("the wall clock cancels the turn and settles 'timeout' even if Bob never acknowledges", async () => {
  const agent = new FakeAgent({ onPrompt: () => new Promise(() => {}) }); // never returns
  const res = await driverFor(agent, { cancelGraceMs: 10 }).dispatch({ text: "x", timeoutMs: 30 });
  assert.equal(res.status, "timeout");
  assert.equal(agent.cancelled, true);
});

test("usage_update over the token ceiling ends the dispatch as 'budget'", async () => {
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      ag.update(p.sessionId, { sessionUpdate: "usage_update", inputTokens: 10, outputTokens: 50 });
      ag.update(p.sessionId, { sessionUpdate: "usage_update", inputTokens: 20, outputTokens: 150 });
      await ag.onCancel();
      return { stopReason: "cancelled" };
    },
  });
  const res = await driverFor(agent).dispatch({ text: "x", tokenCeiling: 100 });
  assert.equal(res.status, "budget");
  assert.equal(res.tokensUsed, 150); // cumulative reports: last-wins, not summed
});

test("a Bob Shell that dies mid-turn settles 'aborted'; cancelActive() ends a turn as 'aborted'", async () => {
  const agent = new FakeAgent({
    onPrompt: async (_p, ag) => {
      setTimeout(() => ag.exit(1), 5);
      return new Promise(() => {});
    },
  });
  const res = await driverFor(agent).dispatch({ text: "x" });
  assert.equal(res.status, "aborted");
  assert.match(res.lastText, /exited \(code 1\)/);

  const agent2 = new FakeAgent({
    onPrompt: async (_p, ag) => {
      await ag.onCancel();
      return { stopReason: "cancelled" };
    },
  });
  const d2 = driverFor(agent2);
  const p = d2.dispatch({ text: "x" });
  setTimeout(() => d2.cancelActive(), 10);
  assert.equal((await p).status, "aborted");
});

test("stop reasons map to statuses; max_turn_requests is a budget stop", async () => {
  for (const [reason, status] of [
    ["max_turn_requests", "budget"],
    ["refusal", "aborted"],
    ["max_tokens", "aborted"],
  ] as const) {
    const agent = new FakeAgent({ onPrompt: async () => ({ stopReason: reason }) });
    assert.equal((await driverFor(agent).dispatch({ text: "x" })).status, status, reason);
  }
});

test("resolveBobLaunch: a bundle path runs under node; a PATH shim is swapped for its bundle; else shell on win32", () => {
  const js = resolveBobLaunch("C:\\x\\bob.js");
  assert.deepEqual(js, { file: process.execPath, args: ["C:\\x\\bob.js"], shell: false });
  const viaPath = resolveBobLaunch(
    "bob",
    "win32",
    "C:\\a;C:\\npm",
    (p) => p === "C:\\npm\\node_modules\\bobshell\\dist\\bob.js",
  );
  assert.deepEqual(viaPath, {
    file: process.execPath,
    args: ["C:\\npm\\node_modules\\bobshell\\dist\\bob.js"],
    shell: false,
  });
  assert.deepEqual(
    resolveBobLaunch("bob", "win32", "", () => false),
    { file: "bob", args: [], shell: true },
  );
  assert.deepEqual(
    resolveBobLaunch("bob", "linux", "", () => false),
    { file: "bob", args: [], shell: false },
  );
});

test("pure helpers: classifyPermission, permissionPolicyFor, parseFollowupArgs, selectOption", () => {
  assert.deepEqual(classifyPermission({ toolCallId: "1", kind: "execute", rawInput: { command: "ls" } }), {
    ask: "command",
    text: "ls",
    modeSwitch: false,
  });
  assert.deepEqual(
    classifyPermission({ toolCallId: "1", title: "switch_mode", rawInput: { mode_id: "plan", reason: "r" } }),
    {
      ask: "tool",
      text: JSON.stringify({ tool: "switchMode", mode: "plan", reason: "r" }),
      modeSwitch: true,
    },
  );
  // A switch identifiable only by its mode_id arg is still a mode switch (the gate, never the policy).
  assert.equal(
    classifyPermission({ toolCallId: "1", title: "Switching", kind: "other", rawInput: { mode_id: "plan" } })
      .modeSwitch,
    true,
  );
  assert.equal(
    classifyPermission({ toolCallId: "1", title: "ask_followup_question", rawInput: { question: "q" } }).ask,
    "followup",
  );
  const policy = permissionPolicyFor({ alwaysAllowWrite: false, alwaysAllowMcp: true, alwaysAllowBrowser: false });
  assert.equal(policy({ toolCallId: "1", kind: "read" }), "allow");
  assert.equal(policy({ toolCallId: "1", kind: "edit" }), "ask");
  assert.equal(policy({ toolCallId: "1", kind: "other", title: "mcp_x" }), "allow");
  assert.equal(policy({ toolCallId: "1", kind: "execute", rawInput: { command: "ls" } }), "ask");
  assert.equal(
    permissionPolicyFor(
      { alwaysAllowWrite: true, alwaysAllowMcp: true, alwaysAllowBrowser: true },
      true,
    )({ toolCallId: "1", kind: "execute", rawInput: { command: "ls" } }),
    "allow",
  );
  assert.deepEqual(parseFollowupArgs({ question: "q", follow_up: [{ answer: "a" }, "b", ""] }), {
    question: "q",
    options: ["a", "b"],
  });
  assert.equal(parseFollowupArgs({}), null);
  assert.deepEqual(selectOption([{ optionId: "ra", kind: "reject_always" }], "reject_once"), {
    outcome: { outcome: "selected", optionId: "ra" },
  });
  assert.deepEqual(selectOption([], "allow_once"), { outcome: { outcome: "cancelled" } });
});

test("a verdict reached by cancel wins over a turn that still ends 'end_turn' in the race", async () => {
  const timer = manualTimer();
  const agent = new FakeAgent({
    onPrompt: async (_p, ag) => {
      await ag.onCancel(); // the cancel arrives, but the turn finishes normally before honoring it
      return { stopReason: "end_turn" };
    },
  });
  const d = driverFor(agent, { timer });
  const p = d.dispatch({ text: "x", idleMs: 1000, onEvent: () => {} });
  setTimeout(() => timer.fire(), 10); // idle trip → session/cancel
  const res = await p;
  assert.equal(res.status, "idle");
});

test("a mode switch carried only by mode_id goes to the gate even when the policy would allow the tool", async () => {
  let outcome: any = null;
  const agent = new FakeAgent({
    onPrompt: async (p, ag) => {
      outcome = await ag.permission(p.sessionId, {
        toolCallId: "m",
        title: "Switching to plan",
        kind: "other",
        rawInput: { mode_id: "plan" },
      });
      return { stopReason: "end_turn" };
    },
  });
  const d = driverFor(agent);
  const asks: string[] = [];
  await d.dispatch({
    text: "x",
    permissionPolicy: () => "allow",
    onEvent: (_n, det) => {
      if (det.ask) {
        asks.push(det.ask);
        d.reject();
      }
    },
  });
  assert.deepEqual(asks, ["tool"]);
  assert.equal(outcome.outcome.optionId, "reject");
});
