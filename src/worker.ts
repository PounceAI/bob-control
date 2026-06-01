#!/usr/bin/env node
import "./suppress-warnings.js";
import * as repo from "./db.js";
import { resolveMode, profileFor, dispatchAutoApprove, RISK_RANK, type Risk } from "./modes.js";
import { createCommandGate } from "./command-gate.js";
import { BobClient, resolvePipe } from "./bob-ipc.js";
import { ExternalActivity } from "./defer.js";
import { notify } from "./notify.js";
import type { Task } from "./types.js";

/**
 * Auto-dispatch loop. Polls the task board for the highest-priority pending
 * task, routes it to a Bob mode (see modes.ts), dispatches over IPC (same-tab,
 * no focus steal), waits for completion, writes completion_result back, then
 * grabs the next. One task at a time.
 *
 *   node dist/worker.js                 drain the board, then idle-poll for more
 *   node dist/worker.js --once          do a single task (or exit if none) and stop
 *   node dist/worker.js --tag rpg       only take tasks with this tag
 *   node dist/worker.js --surface newTab open each task in a new editor tab (steals focus)
 *   node dist/worker.js --max-risk safe only run safe (read-only) tasks unattended
 *   node dist/worker.js --no-notify     silence the per-task desktop toast/sound/bell
 *   node dist/worker.js --no-defer      don't pause while you're chatting with Bob
 *   node dist/worker.js --dry-run       show routing/claims without dispatching to Bob
 *   node dist/worker.js --emit-json     also print @@WORKER {json} event lines (for the extension)
 * Flags: --pipe <path>  --poll <ms>  --timeout <ms>  --assignee <name>  --defer-idle <ms>
 *
 * Each mode has a risk level (safe < standard < elevated); only tasks at or
 * below --max-risk are dispatched. While the user is chatting with Bob, dispatch
 * is held (a same-tab dispatch would abort the live chat) until the chat has
 * been idle for --defer-idle ms.
 */

interface Opts {
  once: boolean;
  newTab: boolean;
  dryRun: boolean;
  notify: boolean;
  defer: boolean;
  deferIdleMs: number;
  deferStaleMs: number;
  commandClassifier: boolean;
  classifierBackend: "api" | "cli";
  classifierModel?: string;
  classifierCli?: string;
  emitJson: boolean;
  tag?: string;
  pipe?: string;
  pollMs: number;
  timeoutMs: number;
  assignee: string;
  maxRisk: Risk;
}

function parseOpts(argv: string[]): Opts {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const maxRisk = (val("--max-risk") ?? "standard") as Risk;
  if (!(maxRisk in RISK_RANK)) {
    console.error(`invalid --max-risk '${maxRisk}' (use safe | standard | elevated)`);
    process.exit(1);
  }
  // --new-tab is an alias for --surface newTab.
  const surface = val("--surface");
  const newTab = has("--new-tab") || surface === "newTab";
  return {
    once: has("--once"),
    newTab,
    dryRun: has("--dry-run"),
    notify: !has("--no-notify"),
    defer: !has("--no-defer"),
    deferIdleMs: Number(val("--defer-idle") ?? 60_000),
    deferStaleMs: Number(val("--defer-stale") ?? 5 * 60_000),
    commandClassifier: has("--command-classifier"),
    classifierBackend: val("--classifier-backend") === "api" ? "api" : "cli",
    classifierModel: val("--classifier-model"),
    classifierCli: val("--classifier-cli"),
    emitJson: has("--emit-json"),
    tag: val("--tag"),
    pipe: val("--pipe"),
    pollMs: Number(val("--poll") ?? 3000),
    timeoutMs: Number(val("--timeout") ?? 300_000),
    assignee: val("--assignee") ?? "bob",
    maxRisk,
  };
}

/**
 * Highest-priority pending task whose mode's risk is at or below the gate.
 * Returns the task plus a count of pending tasks skipped because they exceed it.
 */
function pickEligible(opts: Opts): { task: Task | null; gated: number } {
  const max = RISK_RANK[opts.maxRisk];
  const pending = repo.listTasks({ status: "pending", tag: opts.tag });
  let gated = 0;
  let task: Task | null = null;
  for (const t of pending) {
    const { mode } = resolveMode(t);
    if (RISK_RANK[profileFor(mode).risk] <= max) {
      task = t;
      break;
    }
    gated++;
  }
  return { task, gated };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(task: Task): string {
  const header = `Task #${task.id}: ${task.title}`;
  const body = task.description?.trim() ? `\n\n${task.description.trim()}` : "";
  return header + body;
}

/** Structured event for the extension (parsed from stdout lines). */
function emit(opts: Opts, type: string, data: Record<string, unknown> = {}): void {
  if (opts.emitJson) console.log(`@@WORKER ${JSON.stringify({ type, ...data })}`);
}

async function runOne(client: BobClient, task: Task, opts: Opts): Promise<void> {
  const { mode, source } = resolveMode(task);
  const profile = profileFor(mode);
  console.log(`\n▶ #${task.id} "${task.title}" → mode {${mode}} (${source}, risk:${profile.risk})`);
  emit(opts, "taskStart", { id: task.id, title: task.title, mode, risk: profile.risk });

  if (opts.dryRun) {
    console.log(`  [dry-run] would claim as @${opts.assignee} and dispatch`);
    return;
  }

  // Task may have been deleted between pickEligible() and now; claimTask returns
  // null if it's gone, so skip rather than dispatch stale data.
  if (!repo.claimTask(task.id, opts.assignee)) {
    console.log(`  (task #${task.id} vanished before claim — skipping)`);
    return;
  }
  repo.addNote(task.id, `Auto-dispatched in mode {${mode}} (${source}, risk:${profile.risk}).`, "worker");

  // Gray-zone command approval: under the classifier policy, commands that miss
  // Bob's static allowlist surface as an `ask` instead of auto-running. Rather than
  // wait for a human, ask Claude and press approve/reject over IPC (needs the Bob
  // button patch). Fail-safe: only an explicit "approve" runs the command.
  const classifierOn = opts.commandClassifier && profile.commandPolicy === "classifier";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // The api backend can't run without a key; the cli backend reuses Claude's login.
  const classifierBlocked = opts.classifierBackend === "api" && !apiKey;
  const commandGate = createCommandGate({
    enabled: classifierOn,
    blocked: classifierBlocked,
    backend: opts.classifierBackend,
    model: opts.classifierModel,
    apiKey,
    cliPath: opts.classifierCli,
    task: { id: task.id, title: task.title },
    cwd: process.cwd(),
    client: { approve: () => client.approve(), reject: () => client.reject() },
    addNote: repo.addNote,
    log: (m) => console.log(m),
  });

  let lastSay = "";
  const res = await client.dispatch({
    text: buildPrompt(task),
    mode,
    config: dispatchAutoApprove(profile), // per-mode auto-approve + policy-derived allowedCommands
    newTab: opts.newTab,
    timeoutMs: opts.timeoutMs,
    onEvent: (name, { say, ask, text, partial }) => {
      if (say && say !== lastSay) {
        lastSay = say;
        const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        console.log(`  · ${name}/${say}${t ? `: ${t}` : ""}`);
      }

      void commandGate({ ask, text, partial });
    },
  });

  // Mark done only on a GENUINE completion: Bob fired taskCompleted, or it
  // emitted a real attempt_completion (completion_result). In some multi-step
  // tasks Bob emits completion_result then taskAborted/timeout — we still keep
  // that real result. A trailing tool payload (e.g. updateTodoList) is NOT a
  // completion: bob-ipc keeps it in res.lastText, never in res.result, so a pure
  // timeout with no completion_result now falls through to 'blocked' below.
  const captured = res.result.trim();
  if (res.status === "completed" || captured) {
    const result = captured || "(completed; no completion_result text captured)";
    repo.setResult(task.id, result, true);
    if (res.status !== "completed") {
      repo.addNote(task.id, `Captured completion_result despite terminal '${res.status}' event.`, "worker");
    }
    const tail = res.status === "completed" ? "" : ` (Bob signalled '${res.status}' after completing)`;
    console.log(`  ✓ done — result captured (${result.length} chars)${tail}`);
    emit(opts, "taskDone", { id: task.id, title: task.title, chars: result.length });
    if (opts.notify) notify(`Bob finished #${task.id}`, `${task.title} — ${result}`);
  } else {
    // No result captured: a genuine failure. On timeout Bob may still be
    // churning, so tell it to stop instead of burning tokens until next dispatch.
    if (res.status === "timeout" && res.taskId) {
      client.cancel(res.taskId);
      console.log(`  ⓧ sent cancel to Bob task ${res.taskId}`);
    }
    // Park as blocked so the loop doesn't spin on it.
    repo.updateStatus(task.id, "blocked");
    const lastText = res.lastText.trim().replace(/\s+/g, " ").slice(0, 140);
    const lastNote = lastText ? ` Last activity: ${lastText}` : "";
    repo.addNote(task.id, `Dispatch ended as '${res.status}' with no completion_result.${lastNote}`, "worker");
    console.log(`  ✗ ${res.status} — task marked blocked`);
    emit(opts, "taskFail", { id: task.id, title: task.title, status: res.status });
    if (opts.notify) notify(`Bob task #${task.id} ${res.status}`, task.title);
  }
}

async function main(): Promise<void> {
  const opts = parseOpts(process.argv.slice(2));
  repo.getDb(); // surface schema errors up front

  const client = new BobClient(opts.pipe);
  const external = new ExternalActivity(Date.now, opts.deferStaleMs);
  client.onTaskEvent((ev) => external.handle(ev));

  console.log(`bob-worker: connecting to ${resolvePipe(opts.pipe)} …`);
  if (!opts.dryRun) {
    try {
      await client.connect();
      console.log("bob-worker: connected.");
    } catch (err) {
      console.error(`bob-worker: could not connect — ${(err as Error).message}`);
      console.error("Is Bob running, launched WITH ROO_CODE_IPC_SOCKET_PATH set? Try bob-control.mjs --list-pipes");
      emit(opts, "error", { message: (err as Error).message });
      process.exit(1);
    }
  }
  emit(opts, "connected", { pipe: resolvePipe(opts.pipe), maxRisk: opts.maxRisk });

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log("\nbob-worker: finishing current task, then stopping… (Ctrl-C again to force)");
  };
  process.on("SIGINT", stop);

  // When hosted by the extension (--emit-json), exit if the parent dies: the
  // spawned stdin pipe emits 'end' on parent death, so we don't orphan-poll
  // forever. Gated so interactive CLI use with a TTY stdin is unaffected.
  if (opts.emitJson) {
    process.stdin.on("end", () => {
      console.log("bob-worker: parent closed stdin — exiting.");
      process.exit(0);
    });
    process.stdin.resume();
  }

  console.log(`bob-worker: risk gate = --max-risk ${opts.maxRisk}; defer=${opts.defer ? `on(${opts.deferIdleMs}ms)` : "off"}.`);
  if (opts.commandClassifier) {
    const be = opts.classifierBackend;
    const dflt = be === "cli" ? "claude-sonnet-4-6" : "claude-haiku-4-5";
    const auth =
      be === "cli"
        ? `${opts.classifierCli ?? "claude"} CLI (reuses Claude login)`
        : process.env.ANTHROPIC_API_KEY
          ? "ANTHROPIC_API_KEY set"
          : "NO API KEY — gray-zone commands wait for a human";
    console.log(`bob-worker: command classifier = on, backend=${be} (${opts.classifierModel ?? dflt}; ${auth}).`);
  }
  let idled = false;
  let deferring = false;
  while (!stopping) {
    // Defer while the user is chatting with Bob, checked before any dispatch so a
    // live conversation is never aborted by our same-tab StartNewTask.
    if (opts.defer && !opts.dryRun && external.shouldDefer(opts.deferIdleMs)) {
      if (!deferring) {
        console.log("bob-worker: deferring — Bob chat active (Ctrl-C to stop).");
        emit(opts, "deferred", {});
        deferring = true;
      }
      await sleep(opts.pollMs);
      continue;
    }
    if (deferring) {
      console.log("bob-worker: chat idle — resuming.");
      emit(opts, "resumed", {});
      deferring = false;
    }

    const { task, gated } = pickEligible(opts);
    if (!task) {
      const gatedMsg =
        gated > 0
          ? ` (${gated} pending task${gated > 1 ? "s" : ""} gated above --max-risk ${opts.maxRisk} — dispatch manually)`
          : "";
      if (opts.once) {
        console.log(`bob-worker: no eligible pending tasks — exiting (--once)${gatedMsg}.`);
        break;
      }
      if (!idled) {
        console.log(`bob-worker: no eligible tasks — idle-polling every ${opts.pollMs}ms${gatedMsg}. (Ctrl-C to stop)`);
        emit(opts, "idle", { gated });
        idled = true;
      }
      await sleep(opts.pollMs);
      continue;
    }
    idled = false;
    try {
      await runOne(client, task, opts);
    } catch (err) {
      console.error(`  ! error on #${task.id}: ${(err as Error).message}`);
      // Don't clobber a task that already completed (e.g. error thrown after the
      // result was captured); only park genuinely unfinished work.
      if (repo.getTask(task.id)?.status !== "done") {
        repo.updateStatus(task.id, "blocked");
        repo.addNote(task.id, `Worker error: ${(err as Error).message}`, "worker");
        emit(opts, "taskFail", { id: task.id, status: "error", message: (err as Error).message });
      }
    }
    if (opts.once) break;
  }

  emit(opts, "stopped", {});
  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("bob-worker fatal:", err);
  process.exit(1);
});
