// Bob Shell over ACP (`bob acp`: JSON-RPC on a child's stdio) presented as a WorkerClient, so the 1.x gate layer
// runs unchanged: `session/request_permission` → an `ask` the gates answer with approve/reject; a turn ending on
// `ask_followup_question` → ask:"followup", answered by sendMessage as the next prompt on the same session;
// `session/update` → watchdog, `usage_update` → budget, `session/cancel` → kills, `stopReason` → completion.
// One process and one session per dispatch.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { AcpConnection, AcpRpcError, type AcpTransport } from "./acp-client.js";
import type { WorkerClient } from "./bob-driver.js";
import type {
  DispatchOptions,
  DispatchResult,
  PermissionDecision,
  PermissionPolicy,
  TaskLifecycleEvent,
  ToolPermissionRequest,
} from "./bob-ipc.js";
import { toBob2Mode } from "./bob2-driver.js";
import { fallbackMode } from "./bob2-modes.js";
import { BudgetTracker, budgetExceeded } from "./budget.js";
import { IdleWatchdog, type WatchdogTimer } from "./watchdog.js";

/** ACP's tool-call view: the permission-request shape plus the streamed status. */
export interface AcpToolCall extends ToolPermissionRequest {
  status?: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type { PermissionDecision, PermissionPolicy };

export interface AcpDriverOptions {
  /** The workspace Bob operates in — `session/new`'s cwd and the child's cwd. */
  cwd: string;
  /** `bob` on PATH by default; a path to the `bob` launcher or to Bob Shell's `bob.js` bundle. */
  bobCommand?: string;
  /** Extra `bob acp` flags, e.g. `--accept-license`, `--disable-mcp`. `--trust` is always passed. */
  extraArgs?: string[];
  /** MCP servers to register into every session (ACP `session/new` mcpServers). */
  mcpServers?: unknown[];
  /** Injected transport factory (tests); default spawns `bob acp`. */
  spawn?: () => AcpTransport;
  /** Extra environment for the child (e.g. BOB_API_KEY). Merged over process.env. */
  env?: Record<string, string>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  timer?: WatchdogTimer;
  /** Timeout for the setup requests (initialize / session/new / set_mode). */
  setupTimeoutMs?: number;
  /** After `session/cancel`, how long to wait for the prompt to return `cancelled` before settling anyway. */
  cancelGraceMs?: number;
}

/** A spawned child's stdio as an AcpTransport; stderr lines go to `onStderr`. `tree` kills the process tree on
 *  Windows, where a cmd.exe wrapper's child would survive a plain kill(). Bob Shell also exits on stdin EOF. */
export function childTransport(child: ChildProcess, onStderr?: (line: string) => void, tree = false): AcpTransport {
  if (!child.stdin || !child.stdout) throw new Error("bob acp: child has no stdio pipes");
  let exited = false;
  let exitCode: number | null = null;
  const exitFns: ((code: number | null) => void)[] = [];
  const fire = (code: number | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    for (const f of exitFns) f(code);
  };
  child.on("exit", (code) => fire(code));
  child.on("error", () => fire(null));
  if (child.stderr && onStderr) {
    let buf = "";
    child.stderr.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onStderr(line);
      }
    });
  }
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    onExit: (fn) => {
      if (exited) fn(exitCode);
      else exitFns.push(fn);
    },
    kill: () => {
      if (exited) return;
      if (tree && process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
          "error",
          () => child.kill(),
        );
      } else child.kill();
    },
  };
}

/** How to launch Bob Shell: a `.js` path runs under this node; a bare `bob` is an npm `.cmd` shim on Windows,
 *  so prefer the `bobshell/dist/bob.js` bundle beside it on PATH and fall back to a shell spawn. */
export function resolveBobLaunch(
  command: string,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? "",
  exists: (p: string) => boolean = existsSync,
): { file: string; args: string[]; shell: boolean } {
  const ext = extname(command).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs")
    return { file: process.execPath, args: [command], shell: false };
  const hasDir = command.includes("/") || command.includes("\\");
  const dirs = hasDir ? [dirname(command)] : pathEnv.split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const bundle = join(d, "node_modules", "bobshell", "dist", "bob.js");
    if (exists(bundle)) return { file: process.execPath, args: [bundle], shell: false };
  }
  // No bundle found: run the command itself. Windows needs a shell for a .cmd/.ps1 shim.
  const shell = platform === "win32" && ext !== ".exe";
  return { file: command, args: [], shell };
}

const STOP_REASON_STATUS: Record<string, DispatchResult["status"]> = {
  end_turn: "completed",
  max_turn_requests: "budget",
  max_tokens: "aborted",
  refusal: "aborted",
};

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

interface PendingPermission {
  respond: (outcome: unknown) => void;
  options: AcpPermissionOption[];
  ask: string;
}

interface Active {
  conn: AcpConnection;
  sessionId: string | null;
  settle: (r: DispatchResult) => void;
  onEvent?: DispatchOptions["onEvent"];
  isAnswerableAsk?: DispatchOptions["isAnswerableAsk"];
  timer: ReturnType<typeof setTimeout>;
  watchdog?: IdleWatchdog;
  budget: BudgetTracker;
  tokenCeiling?: number;
  turnCap?: number;
  done: boolean;
  /** Status to settle with once a cancelled turn returns (set by endWith). */
  pendingStatus?: DispatchResult["status"];
  cancelTimer?: ReturnType<typeof setTimeout>;
  turnInFlight: boolean;
  /** The assistant's message text in the current turn (fallback result when no attempt_completion). */
  turnText: string;
  lastCompletion: string;
  lastText: string;
  pendingAsk?: string;
  pendingAskText?: string;
  pendingPermission: PendingPermission | null;
  pendingFollowup: { question: string; options: string[] } | null;
  toolCalls: Map<string, AcpToolCall>;
  usage: { mode: "unknown" | "cumulative" | "perRequest"; lastOut: number; n: number };
  /** Prompt turns sent on this session (the initial task + each followup answer). */
  prompts: number;
}

/** Read a followup question from Bob's `ask_followup_question` args ({question, follow_up:[…]}). */
export function parseFollowupArgs(
  raw: Record<string, unknown> | undefined,
): { question: string; options: string[] } | null {
  const question = typeof raw?.question === "string" ? raw.question.trim() : "";
  if (!question) return null;
  const list = Array.isArray(raw?.follow_up) ? raw.follow_up : Array.isArray(raw?.suggest) ? raw.suggest : [];
  const options = list
    .map((o: unknown) => (typeof o === "string" ? o : typeof (o as any)?.answer === "string" ? (o as any).answer : ""))
    .filter((s: string) => s.trim().length > 0);
  return { question, options };
}

const FOLLOWUP_TOOL = /ask_followup_question|followup/i;
const COMPLETION_TOOL = /attempt_completion/i;
const SWITCH_MODE_TOOL = /switch_mode/i;

/** Which 1.x ask a permission prompt maps to, and its payload text — the shape the gates already parse.
 *  `modeSwitch` marks a switch_mode prompt (by title, kind, or a mode_id arg): those always go to the
 *  mode-switch gate, never to the permission policy. */
export function classifyPermission(tc: AcpToolCall): {
  ask: "command" | "tool" | "followup";
  text: string;
  modeSwitch: boolean;
} {
  const raw = tc.rawInput ?? {};
  const title = tc.title ?? "";
  if (typeof raw.command === "string" && (tc.kind === "execute" || tc.kind === undefined)) {
    return { ask: "command", text: raw.command, modeSwitch: false };
  }
  if (SWITCH_MODE_TOOL.test(title) || tc.kind === "switch_mode" || typeof raw.mode_id === "string") {
    const mode = typeof raw.mode_id === "string" ? raw.mode_id : typeof raw.mode === "string" ? raw.mode : "";
    return {
      ask: "tool",
      text: JSON.stringify({ tool: "switchMode", mode, reason: raw.reason ?? "" }),
      modeSwitch: true,
    };
  }
  if (FOLLOWUP_TOOL.test(title)) {
    return { ask: "followup", text: JSON.stringify(parseFollowupArgs(raw) ?? {}), modeSwitch: false };
  }
  return {
    ask: "tool",
    text: JSON.stringify({ tool: title || tc.kind || "unknown", kind: tc.kind, ...raw }),
    modeSwitch: false,
  };
}

/** The policy a mode profile's auto-approve flags imply: edits need alwaysAllowWrite, MCP/fetch alwaysAllowMcp,
 *  commands only `allowAllCommands` (else the gates decide). "ask" for a tool nobody answers headless → the
 *  watchdog's short grace ends the dispatch as needs_input, as under the 1.x pipe. */
export function permissionPolicyFor(
  auto: { alwaysAllowWrite: boolean; alwaysAllowMcp: boolean; alwaysAllowBrowser: boolean },
  allowAllCommands = false,
): PermissionPolicy {
  return (tc) => {
    if (typeof tc.rawInput?.command === "string" && (tc.kind === "execute" || tc.kind === undefined)) {
      return allowAllCommands ? "allow" : "ask";
    }
    switch (tc.kind) {
      case "read":
      case "search":
      case "think":
        return "allow";
      case "edit":
      case "delete":
      case "move":
        return auto.alwaysAllowWrite ? "allow" : "ask";
      case "fetch":
        return auto.alwaysAllowMcp || auto.alwaysAllowBrowser ? "allow" : "ask";
      default:
        // "other" covers MCP tools, todo lists, subagents; the followup tool is answered via the turn.
        if (FOLLOWUP_TOOL.test(tc.title ?? "")) return "allow";
        return auto.alwaysAllowMcp ? "allow" : "ask";
    }
  };
}

export class AcpDriver implements WorkerClient {
  private active: Active | null = null;
  private observer: ((ev: TaskLifecycleEvent) => void) | null = null;
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string) => void;
  private readonly setupTimeoutMs: number;
  private readonly cancelGraceMs: number;
  /** Bob Shell's self-description from `initialize` (logging). */
  agentInfo: { name?: string; version?: string } | null = null;
  private warnedNoUsage = false;

  constructor(private readonly opts: AcpDriverOptions) {
    this.log = opts.log ?? (() => {});
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.setupTimeoutMs = opts.setupTimeoutMs ?? 60_000;
    this.cancelGraceMs = opts.cancelGraceMs ?? 5_000;
  }

  private spawnTransport(): AcpTransport {
    if (this.opts.spawn) return this.opts.spawn();
    const launch = resolveBobLaunch(this.opts.bobCommand ?? "bob");
    const args = [...launch.args, "acp", "--trust", ...(this.opts.extraArgs ?? [])];
    const child = spawn(launch.file, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      shell: launch.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return childTransport(child, (line) => this.log(`  [bob] ${line}`), launch.shell);
  }

  private async newSession(conn: AcpConnection): Promise<{ sessionId: string; modes?: any }> {
    try {
      return await conn.request(
        "session/new",
        { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] },
        this.setupTimeoutMs,
      );
    } catch (e) {
      if (e instanceof AcpRpcError && (e.code === -32000 || /auth/i.test(e.message))) {
        throw new Error(
          "Bob Shell authentication required — run `bob` once to log in (SSO), or set BOB_API_KEY for the worker",
        );
      }
      throw e;
    }
  }

  /** Prove Bob Shell launches, speaks ACP and is authenticated: one throwaway session, deleted again so it
   *  leaves no empty task in the shared ~/.bob/db/bob.db history, then close. */
  async connect(): Promise<void> {
    const conn = new AcpConnection(this.spawnTransport(), this.log);
    try {
      const init = await conn.request("initialize", INIT_PARAMS, this.setupTimeoutMs);
      this.agentInfo = init?.agentInfo ?? null;
      const { sessionId } = await this.newSession(conn);
      try {
        await conn.request("session/delete", { sessionId }, this.setupTimeoutMs);
      } catch {
        /* an agent without session/delete just keeps the probe row */
      }
    } finally {
      conn.close();
    }
  }

  async queryWorkspace(): Promise<string | null> {
    return this.opts.cwd;
  }

  onTaskEvent(fn: (ev: TaskLifecycleEvent) => void): void {
    this.observer = fn;
  }

  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    if (this.active) throw new Error("AcpDriver is busy — dispatch tasks sequentially");
    const timeoutMs = opts.timeoutMs ?? 300_000;
    return new Promise<DispatchResult>((resolve) => {
      let conn: AcpConnection;
      try {
        conn = new AcpConnection(this.spawnTransport(), this.log);
      } catch (e) {
        resolve({
          taskId: null,
          result: "",
          lastText: `bob acp spawn failed: ${(e as Error).message}`,
          status: "aborted",
          tokensUsed: 0,
          turns: 0,
        });
        return;
      }
      const a: Active = {
        conn,
        sessionId: null,
        settle: resolve,
        onEvent: opts.onEvent,
        isAnswerableAsk: opts.isAnswerableAsk,
        timer: setTimeout(() => this.endWith("timeout"), timeoutMs),
        budget: new BudgetTracker(),
        tokenCeiling: opts.tokenCeiling,
        turnCap: opts.turnCap,
        done: false,
        turnInFlight: false,
        turnText: "",
        lastCompletion: "",
        lastText: "",
        pendingPermission: null,
        pendingFollowup: null,
        toolCalls: new Map(),
        usage: { mode: "unknown", lastOut: 0, n: 0 },
        prompts: 0,
      };
      if (opts.idleMs && opts.idleMs > 0) {
        a.watchdog = new IdleWatchdog({
          idleMs: opts.idleMs,
          blockedAskGraceMs: opts.blockedAskGraceMs ?? 0,
          timer: this.opts.timer,
          onTrip: () => this.endWith("idle"),
        });
      }
      this.active = a;
      conn.onNotification("session/update", (p) => this.onUpdate(a, p));
      conn.onRequest("session/request_permission", (p) => this.onPermission(a, p, opts));
      conn.onClose((code) => {
        if (!a.done) {
          a.lastText = a.lastText || `bob acp exited (code ${code ?? "signal"})`;
          this.finish(a, "aborted");
        }
      });
      a.watchdog?.start();
      void this.run(a, conn, opts);
    });
  }

  private async run(a: Active, conn: AcpConnection, opts: DispatchOptions): Promise<void> {
    try {
      const init = await conn.request("initialize", INIT_PARAMS, this.setupTimeoutMs);
      this.agentInfo = init?.agentInfo ?? this.agentInfo;
      const sess = await this.newSession(conn);
      if (a.done) return; // the wall clock can fire mid-setup; a settled dispatch must not report a created task
      a.sessionId = sess.sessionId;
      this.observer?.({ name: "taskCreated", taskId: sess.sessionId, isOwn: true });
      await this.selectMode(a, conn, sess.modes, opts.mode);
      if (a.done) return;
      await this.promptTurn(a, opts.text);
    } catch (e) {
      if (a.done) return;
      a.lastText = (e as Error).message;
      this.finish(a, "aborted");
    }
  }

  /** Ask for the board's mode (1.x slugs mapped to 2.x built-ins), downgrading to the mode's read-only /
   *  agent fallback when the session doesn't offer it — same policy as the in-process driver. */
  private async selectMode(
    a: Active,
    conn: AcpConnection,
    modes: any,
    requested: string | null | undefined,
  ): Promise<void> {
    const wanted = toBob2Mode(requested);
    const available: string[] | null = Array.isArray(modes?.availableModes)
      ? modes.availableModes.map((m: any) => String(m?.id ?? "")).filter(Boolean)
      : null;
    const current: string | undefined = typeof modes?.currentModeId === "string" ? modes.currentModeId : undefined;
    let target = wanted;
    if (available && !available.includes(wanted)) {
      const fb = fallbackMode(wanted);
      target = available.includes(fb) ? fb : (current ?? wanted);
      this.warn(
        `bob acp: mode '${wanted}' is not offered by this session (available: ${available.join(", ")}) — running as '${target}'.`,
      );
    }
    if (target === current) return;
    try {
      await conn.request("session/set_mode", { sessionId: a.sessionId, modeId: target }, this.setupTimeoutMs);
    } catch (e) {
      // A refused switch isn't fatal: the turn still runs in the session's current mode.
      this.warn(
        `bob acp: session/set_mode '${target}' failed (${(e as Error).message}) — running in '${current ?? "default"}'.`,
      );
    }
  }

  private beginTurn(a: Active): void {
    a.prompts += 1;
    a.turnInFlight = true;
    a.turnText = "";
    a.pendingFollowup = null;
  }

  private async promptTurn(a: Active, text: string): Promise<void> {
    this.beginTurn(a);
    let stopReason = "";
    try {
      const r = await a.conn.request("session/prompt", {
        sessionId: a.sessionId,
        prompt: [{ type: "text", text }],
      });
      stopReason = String(r?.stopReason ?? "end_turn");
    } catch (e) {
      if (a.done) return;
      a.lastText = (e as Error).message;
      this.finish(a, "aborted");
      return;
    } finally {
      a.turnInFlight = false;
    }
    if (a.done) return;
    // A verdict endWith() already reached (idle/timeout/budget/abort) wins over whatever the turn returns:
    // session/cancel is fire-and-forget, so a turn can still end "end_turn" in the race before it lands.
    if (a.pendingStatus || stopReason === "cancelled") {
      this.finish(a, a.pendingStatus ?? "aborted");
      return;
    }
    const followup = a.pendingFollowup;
    if (stopReason === "end_turn" && followup) {
      // Bob asked a question and yielded the turn: surface it as the 1.x followup ask. The followup gate
      // answers via sendMessage → the next prompt on this session; nobody answering trips the watchdog.
      const askText = JSON.stringify({
        question: followup.question,
        suggest: followup.options.map((answer: string) => ({ answer })),
      });
      a.pendingAsk = "followup";
      a.pendingAskText = askText;
      const answerable = a.isAnswerableAsk ? a.isAnswerableAsk("followup", askText) : false;
      a.watchdog?.ask("followup", askText, answerable);
      this.emit(a, "ask", { ask: "followup", text: askText, partial: false });
      return;
    }
    this.finish(a, STOP_REASON_STATUS[stopReason] ?? "aborted");
  }

  private emit(
    a: Active,
    name: string,
    detail: { say?: string; ask?: string; text?: string; partial?: boolean },
  ): void {
    a.onEvent?.(name, { ...detail, ts: Date.now(), taskId: a.sessionId ?? undefined, isRoot: true });
  }

  private onUpdate(a: Active, params: any): void {
    if (a.done) return;
    const u = params?.update ?? {};
    const kind: string = u.sessionUpdate ?? "";
    switch (kind) {
      case "agent_message_chunk": {
        const t = typeof u.content?.text === "string" ? u.content.text : "";
        a.turnText += t;
        if (a.turnText.trim()) a.lastText = a.turnText.trim().slice(-2000);
        this.progress(a);
        this.emit(a, "message", { say: "text", text: t, partial: true });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        const prev = a.toolCalls.get(id);
        const tc: AcpToolCall = {
          toolCallId: id,
          title: u.title ?? prev?.title,
          kind: u.kind ?? prev?.kind,
          status: u.status ?? prev?.status,
          // Bob sends rawInput:"" on tool_call_update frames; keep the tool_call's real args.
          rawInput:
            u.rawInput && typeof u.rawInput === "object" ? (u.rawInput as Record<string, unknown>) : prev?.rawInput,
        };
        a.toolCalls.set(id, tc);
        const title = tc.title ?? "";
        if (COMPLETION_TOOL.test(title) && typeof tc.rawInput?.result === "string" && tc.rawInput.result.trim()) {
          a.lastCompletion = tc.rawInput.result;
        }
        if (FOLLOWUP_TOOL.test(title)) {
          const f = parseFollowupArgs(tc.rawInput);
          if (f) a.pendingFollowup = f;
        }
        this.progress(a);
        if (kind === "tool_call") {
          const text = JSON.stringify({ tool: title || tc.kind || "tool", kind: tc.kind, ...(tc.rawInput ?? {}) });
          a.lastText = text.slice(0, 2000);
          this.emit(a, "tool", { say: "tool", text, partial: false });
        }
        return;
      }
      case "usage_update": {
        const out = num(u.outputTokens ?? u.output_tokens ?? u.used);
        const inp = num(u.inputTokens ?? u.input_tokens);
        if (out === undefined && inp === undefined) return;
        const us = a.usage;
        us.n += 1;
        // Bob may report cumulative session totals or per-request counts; a value that shrinks proves the
        // latter. Cumulative → one last-wins slot; per-request → one slot per report (summed).
        if (us.mode === "unknown" && us.n > 1) us.mode = (out ?? 0) < us.lastOut ? "perRequest" : "cumulative";
        us.lastOut = out ?? us.lastOut;
        const key = us.mode === "perRequest" ? `req:${us.n}` : "session";
        a.budget.update(key, { tokensIn: inp, tokensOut: out });
        const over = budgetExceeded(
          { outputTokens: a.budget.outputTokens, turns: us.n },
          { tokenCeiling: a.tokenCeiling, turnCap: a.turnCap },
        );
        if (over) {
          this.log(`  ⛔ budget: ${over}`);
          this.endWith("budget");
        }
        return;
      }
      case "agent_thought_chunk":
      case "plan":
      case "current_mode_update":
        this.progress(a);
        return;
      default:
        return;
    }
  }

  private progress(a: Active): void {
    a.pendingAsk = undefined;
    a.pendingAskText = undefined;
    a.watchdog?.activity();
  }

  /** Answer `session/request_permission`: settle it from the policy, or park it as an `ask` for the gates. */
  private onPermission(a: Active, params: any, opts: DispatchOptions): Promise<unknown> {
    const tc: AcpToolCall = {
      toolCallId: String(params?.toolCall?.toolCallId ?? ""),
      title: params?.toolCall?.title,
      kind: params?.toolCall?.kind,
      rawInput: params?.toolCall?.rawInput,
    };
    const options: AcpPermissionOption[] = Array.isArray(params?.options) ? params.options : [];
    if (a.done) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const { ask, text, modeSwitch } = classifyPermission(tc);
    let decision: PermissionDecision = "ask";
    if (ask === "followup")
      decision = "allow"; // harmless: the question itself arrives via the turn
    else if (modeSwitch)
      decision = "ask"; // the mode-switch gate decides, never the policy
    else if (opts.permissionPolicy) {
      const d = opts.permissionPolicy(tc);
      // A command is never policy-REJECTED here: the permission gate owns denies (and surfaces them).
      decision = ask === "command" && d === "reject" ? "ask" : d;
    }
    if (decision !== "ask") {
      this.log(`  ${decision === "allow" ? "✓" : "✗"} ${decision} (policy) ${tc.title ?? tc.kind ?? "tool"}`);
      this.progress(a); // a policy-settled prompt is progress too, else a burst of allowed tools reads as idle
      return Promise.resolve(selectOption(options, decision === "allow" ? "allow_once" : "reject_once"));
    }
    return new Promise((resolve) => {
      // Only one prompt is outstanding at a time (ACP serializes tool calls); a stray second one is cancelled.
      if (a.pendingPermission) {
        this.log(
          `  ~ permission prompt for ${tc.title ?? tc.kind ?? "tool"} arrived while another is pending — cancelled`,
        );
        resolve({ outcome: { outcome: "cancelled" } });
        return;
      }
      a.pendingPermission = { respond: resolve, options, ask };
      a.pendingAsk = ask;
      a.pendingAskText = text;
      const answerable = a.isAnswerableAsk ? a.isAnswerableAsk(ask, text) : false;
      a.watchdog?.ask(ask, text, answerable);
      this.emit(a, "ask", { ask, text, partial: false });
    });
  }

  private settlePermission(kind: "allow_once" | "reject_once"): boolean {
    const a = this.active;
    if (!a || !a.pendingPermission) return false;
    const p = a.pendingPermission;
    a.pendingPermission = null;
    p.respond(selectOption(p.options, kind));
    this.progress(a);
    return true;
  }

  /** One session per dispatch, so the task id the gates pass is implied. */
  approve(_taskId?: string): void {
    if (!this.settlePermission("allow_once")) this.log("  ~ approve: no pending permission prompt");
  }

  reject(_taskId?: string): void {
    if (!this.settlePermission("reject_once")) this.log("  ~ reject: no pending permission prompt");
  }

  /** Answer a followup (the next prompt on the session). Ignored while a turn is in flight — ACP takes one
   *  prompt at a time, and Bob has nothing pending to answer then. */
  sendMessage(text: string): void {
    const a = this.active;
    if (!a || a.done) return;
    if (a.turnInFlight) {
      this.log("  ~ sendMessage while a turn is in flight — dropped (ACP takes one prompt at a time)");
      return;
    }
    this.progress(a);
    void this.promptTurn(a, text);
  }

  cancel(_taskId?: string): void {
    this.endWith("aborted");
  }

  cancelActive(): void {
    this.endWith("aborted");
  }

  /** End the in-flight dispatch as `status`: cancel the turn, wait briefly for `cancelled`, then settle. */
  private endWith(status: DispatchResult["status"]): void {
    const a = this.active;
    if (!a || a.done || a.pendingStatus) return;
    a.pendingStatus = status;
    if (a.sessionId && a.turnInFlight) {
      a.conn.notify("session/cancel", { sessionId: a.sessionId });
      a.cancelTimer = setTimeout(() => this.finish(a, status), this.cancelGraceMs);
    } else {
      this.finish(a, status);
    }
  }

  private finish(a: Active, status: DispatchResult["status"]): void {
    if (a.done) return;
    a.done = true;
    clearTimeout(a.timer);
    if (a.cancelTimer) clearTimeout(a.cancelTimer);
    a.watchdog?.stop();
    if (a.pendingPermission) {
      a.pendingPermission.respond({ outcome: { outcome: "cancelled" } });
      a.pendingPermission = null;
    }
    if (this.active === a) this.active = null;
    // No usage_update (Bob Shell 2.0.2) means a configured token budget can never trip — say so once.
    if (a.tokenCeiling && a.usage.n === 0 && a.sessionId && !this.warnedNoUsage) {
      this.warnedNoUsage = true;
      this.warn(
        "bob acp: this Bob Shell sent no usage_update — the token budget is inert over ACP (wall clock + idle watchdog still apply)",
      );
    }
    if (a.sessionId) {
      this.observer?.({
        name: status === "completed" ? "taskCompleted" : "taskAborted",
        taskId: a.sessionId,
        isOwn: true,
      });
    }
    // Only a completed turn's text counts as the result; a captured attempt_completion survives any ending.
    const result = a.lastCompletion || (status === "completed" ? a.turnText.trim() : "");
    a.settle({
      taskId: a.sessionId,
      result,
      lastText: a.lastText,
      status,
      pendingAsk: a.pendingAsk,
      pendingAskText: a.pendingAskText,
      tokensUsed: a.budget.outputTokens,
      // Prompt turns when Bob sent no usage (2.0.2), so a run never reads as 0 tokens AND 0 turns.
      turns: a.usage.n || a.prompts,
    });
    // A permission reply settled above is written on a microtask; close after it lands, not before.
    setImmediate(() => a.conn.close());
  }

  close(): void {
    const a = this.active;
    if (a && !a.done) {
      a.lastText = a.lastText || "driver closed";
      this.finish(a, "aborted");
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The `session/request_permission` response for the option of `kind` (first option of that kind, else
 *  the closest: an allow falls back to allow_always, a reject to reject_always / cancelled). */
export function selectOption(options: AcpPermissionOption[], kind: "allow_once" | "reject_once"): unknown {
  const order = kind === "allow_once" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of order) {
    const o = options.find((x) => x.kind === k);
    if (o) return { outcome: { outcome: "selected", optionId: o.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
