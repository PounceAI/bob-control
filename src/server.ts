#!/usr/bin/env node
import "./suppress-warnings.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as repo from "./db.js";
import { TASK_STATUSES, TASK_PRIORITIES, ARTIFACT_KINDS, isFinished } from "./types.js";
import type { Task, TaskStatus } from "./types.js";
import { resolveMode, isReadOnlyMode, profileFor } from "./modes.js";
import { revertTaskToCheckpoint, deleteTaskAndCheckpoint } from "./checkpoint.js";
import { buildReport } from "./report.js";
import { awaitTaskOutcome } from "./await-task.js";

// Max live tasks board_status inlines as open_tasks before it flags open_tasks_truncated.
const OPEN_TASKS_CAP = 50;

// await_answer blocks server-side in chunks so a single tool call stays under the MCP
// transport timeout while the total human wait can be minutes (the worker re-calls).
const AWAIT_CHUNK_DEFAULT_MS = 25_000;
const AWAIT_CHUNK_MAX_MS = 55_000;
const AWAIT_POLL_INTERVAL_MS = 700;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Would a live drainer pull a task carrying `taskTags` right now? A worker pulls a task only if its
 *  --tag pin is null (drains all tags) or matches one of the task's tags. Heartbeat-based, so — unlike
 *  the old in-progress heuristic — it fires for a live-but-idle drainer, which is exactly the
 *  mid-curation race the create_task warning guards against. */
function liveDrainerWouldPull(taskTags: string[] = []): boolean {
  const live = repo.getWorkerLiveness();
  if (!live.draining) return false;
  const wanted = new Set(taskTags);
  return live.tags.some((pin) => pin === null || wanted.has(pin));
}

// Bob Control MCP server. Bob connects and gets tools to pull, claim,
// log, and complete tasks; work is provisioned via create_task or the CLI and
// persisted in local SQLite.
//
// stdio server: stdout is reserved for the MCP protocol, so all logging goes to
// stderr via console.error.

const server = new McpServer({
  name: "bob-control",
  version: "2.1.0",
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function json(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Shared skeleton for the await_* tools: block server-side in chunks so a single call stays under
// the MCP transport timeout while the total wait spans minutes (the caller re-invokes). Poll
// `settle` every AWAIT_POLL_INTERVAL_MS until it yields a terminal result; return null once the
// per-call `window` elapses, so the caller renders its own tool-specific 'waiting' response.
async function awaitPoll(window: number, settle: () => ToolResult | null): Promise<ToolResult | null> {
  const deadline = Date.now() + window;
  for (;;) {
    const result = settle();
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await sleep(AWAIT_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Provisioning (used by you / Claude, also available to Bob)
// ---------------------------------------------------------------------------

server.registerTool(
  "create_task",
  {
    title: "Create Task",
    description: "Provision a new task for Bob to work on. Returns the created task including its id.",
    inputSchema: {
      title: z.string().min(1).describe("Short, action-oriented task title"),
      description: z.string().optional().describe("Detailed instructions, context, and acceptance criteria"),
      priority: z.enum(TASK_PRIORITIES).optional().describe("Priority bucket (default: medium)"),
      tags: z.array(z.string()).optional().describe("Labels for filtering, e.g. ['rpg','refactor']"),
      mode: z
        .string()
        .optional()
        .describe(
          "Bob mode to run this task in: 'code' | 'advanced' (adds MCP/Browser) | 'ask' (read-only) | 'orchestrator', or a custom mode slug. Omit to let the dispatcher auto-route from the task content.",
        ),
      depends_on: z
        .array(z.number().int())
        .optional()
        .describe("Task IDs this task depends on (all must be 'done' before this task is eligible)"),
      staged: z
        .boolean()
        .optional()
        .describe(
          "Create the task non-pullable ('staged') so a running worker can't grab it mid-curation. Release later with release_tasks. Use for bulk-create + triage.",
        ),
    },
  },
  async ({ title, description, priority, tags, mode, depends_on, staged }) => {
    try {
      const task = repo.createTask({ title, description, priority, tags, mode, depends_on, staged });
      // Warn when a pullable task drops onto a live board (bulk-create race).
      if (!staged && repo.isBoardArmed() && liveDrainerWouldPull(task.tags)) {
        return json({
          ...task,
          warning:
            "Board is ARMED and a live worker drains this task's tags — it may be pulled before you finish " +
            "curating. Disarm the board (disarm_board) or create staged:true while bulk-creating, then release_tasks.",
        });
      }
      return json(task);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// ---------------------------------------------------------------------------
// Consumption (primarily used by Bob)
// ---------------------------------------------------------------------------

server.registerTool(
  "list_tasks",
  {
    title: "List Tasks",
    description: "List tasks, optionally filtered by status and/or tag. Ordered by priority, then oldest first.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async ({ status, tag, limit }) => json(repo.listTasks({ status, tag, limit })),
);

server.registerTool(
  "get_task",
  {
    title: "Get Task",
    description: "Get full details of a single task, including its notes / work log.",
    inputSchema: { id: z.number().int().describe("Task id") },
  },
  async ({ id }) => {
    const task = repo.getTask(id);
    if (!task) return fail(`Task ${id} not found`);
    return json({
      ...task,
      notes: repo.getNotes(id),
      // Surface an open human-input question so any board client can read/answer it.
      pending_question: repo.getOpenQuestion(id),
    });
  },
);

server.registerTool(
  "get_next_task",
  {
    title: "Get Next Task",
    description:
      "Fetch the highest-priority pending task. Optionally filter by tag, and optionally claim it (mark in_progress + assign) in the same call.",
    inputSchema: {
      tag: z.string().optional(),
      claim: z.boolean().optional().describe("If true, immediately mark the task in_progress and assign it"),
      assignee: z.string().optional().describe("Who is taking the task (default: 'bob')"),
    },
  },
  async ({ tag, claim, assignee }) => {
    repo.expireOverdueQuestions(); // sweep stale questions so timeouts fire even if the asker died
    const task = repo.nextTask({ tag });
    // null also means the board is disarmed — say so rather than look empty.
    if (!task) {
      if (!repo.isBoardArmed())
        return json({ task: null, board: "disarmed", note: "dispatch is paused; arm the board to pull" });
      return json(null);
    }
    if (claim) {
      const reason = repo.claimBlockReason(task.id);
      if (reason) return fail(reason);
      return json(repo.claimTask(task.id, assignee ?? "bob"));
    }
    return json(task);
  },
);

server.registerTool(
  "predict_mode",
  {
    title: "Predict Mode",
    description:
      "Preview which Bob mode a task dispatches in, computed from the connector's router (modes.ts) — the " +
      "single source of truth, so callers never re-encode the keyword table. Pass `id` to route an existing " +
      "task, or `text` to route a hypothetical task (the text is treated as the title). Resolution order " +
      "(first match wins): an " +
      "explicit `mode` › a tag naming a mode › the keyword auto-router › `code`. Returns {mode, source: " +
      "explicit|tag|auto-router|default, risk: safe|standard|elevated}. Risk gates dispatch — the worker " +
      "auto-runs only at/below its --max-risk (default standard), so an `advanced` (elevated) task waits " +
      "for manual dispatch.",
    inputSchema: {
      id: z.number().int().optional().describe("Route an existing task by id"),
      text: z.string().optional().describe("Route hypothetical task text (treated as the task title) instead of an id"),
    },
  },
  async ({ id, text }) => {
    let task: Pick<Task, "mode" | "title" | "description" | "tags">;
    if (id !== undefined) {
      const t = repo.getTask(id);
      if (!t) return fail(`Task ${id} not found`);
      task = t;
    } else if (text && text.trim()) {
      task = { mode: null, title: text.trim(), description: null, tags: [] };
    } else {
      return fail("predict_mode needs either `id` or `text`");
    }
    const { mode, source } = resolveMode(task);
    return json({ mode, source, risk: profileFor(mode).risk });
  },
);

server.registerTool(
  "claim_task",
  {
    title: "Claim Task",
    description: "Mark a task as in_progress and assign it to an owner.",
    inputSchema: {
      id: z.number().int(),
      assignee: z.string().optional().describe("Owner (default: 'bob')"),
    },
  },
  async ({ id, assignee }) => {
    // Precise refusal: not found vs. staged/non-pending vs. board disarmed.
    const reason = repo.claimBlockReason(id);
    if (reason) return fail(reason);
    const task = repo.claimTask(id, assignee ?? "bob");
    if (!task) return fail(`Task ${id} could not be claimed`);
    return json(task);
  },
);

server.registerTool(
  "update_task_status",
  {
    title: "Update Task Status",
    description: "Change a task's status (pending | in_progress | blocked | done | cancelled).",
    inputSchema: {
      id: z.number().int(),
      status: z.enum(TASK_STATUSES),
    },
  },
  async ({ id, status }) => {
    if (!repo.getTask(id)) return fail(`Task ${id} not found`);
    // 'staged' and 'needs_input' aren't arbitrary transitions: 'staged' would reopen the pull
    // race, and 'needs_input' must carry a real question (only ask_question may set it, else the
    // task is an orphaned awaiting-answer with nothing to answer).
    if (status === "staged" || status === "needs_input") {
      return fail(
        `cannot move a task to '${status}' via update_task_status; use ${status === "staged" ? "create staged:true / release_tasks" : "ask_question"}`,
      );
    }
    const task = repo.updateStatus(id, status);
    // Settling a task (cancelled here; done/analysis_done go through completeTask) closes any
    // still-open board question, so a late answer can't resurrect it into a redundant re-dispatch.
    if (isFinished(status)) {
      repo.closeOpenQuestions(id, `task moved to '${status}'`);
    }
    // Manual done is allowed (backward-compatible), but flag it when there's no
    // recorded execution evidence so the board distinguishes verified from asserted.
    if (status === "done" && !repo.hasEvidence(id)) {
      repo.addNote(id, "Marked done manually without recorded execution evidence (unverified).", "system");
      return json({
        ...task,
        warning:
          "Marked done without execution evidence — recorded an 'unverified' note. " +
          "Prefer submit_result with evidence; use 'analysis_done' for read-only/analysis work.",
      });
    }
    return json(task);
  },
);

server.registerTool(
  "add_task_note",
  {
    title: "Add Task Note",
    description: "Append a progress note / work-log entry to a task.",
    inputSchema: {
      id: z.number().int(),
      note: z.string().min(1),
      author: z.string().optional().describe("Note author (default: 'bob')"),
    },
  },
  async ({ id, note, author }) => {
    const created = repo.addNote(id, note, author ?? "bob");
    if (!created) return fail(`Task ${id} not found`);
    return json(created);
  },
);

server.registerTool(
  "submit_result",
  {
    title: "Submit Result",
    description:
      "Attach a result to a task and complete it. A read-only run (ask/plan/review mode) " +
      "terminates as 'analysis_done', not 'done'. To reach 'done' on an implementation task, " +
      "pass `evidence` (files changed / commit / test result); without evidence it lands in " +
      "'analysis_done'. Pass mark_done:false to just attach the result without completing.",
    inputSchema: {
      id: z.number().int(),
      result: z.string().min(1),
      mark_done: z.boolean().optional().describe("Complete the task (default: true). false = attach result only."),
      evidence: z
        .object({
          files: z.array(z.string()).optional().describe("Paths created/changed (recorded as artifacts)"),
          files_changed: z.number().int().optional(),
          commit: z.string().optional().describe("Commit sha produced"),
          test: z.string().optional().describe("Verification result, e.g. 'npm test: 42 passed'"),
          diffstat: z.string().optional(),
        })
        .optional()
        .describe("Proof of execution required for an implementation task to reach 'done'."),
    },
  },
  async ({ id, result, mark_done, evidence }) => {
    const existing = repo.getTask(id);
    if (!existing) return fail(`Task ${id} not found`);
    if (mark_done === false) return json(repo.setResult(id, result, false));

    const { mode } = resolveMode(existing);
    const ranReadOnly = isReadOnlyMode(mode);
    const task = repo.completeTask(id, { result, ranReadOnly, evidence });
    const gate = ranReadOnly
      ? `read-only mode {${mode}} → analysis_done (analysis is the deliverable; not 'done')`
      : task?.status === "done"
        ? "implementation with evidence → done"
        : "implementation without evidence → analysis_done (record evidence to reach done)";
    return json({ ...task, gate });
  },
);

// ---------------------------------------------------------------------------
// Human-input round-trip (ask on the board, answer through the board)
// ---------------------------------------------------------------------------

server.registerTool(
  "ask_question",
  {
    title: "Ask a Question (needs human input)",
    description:
      "Raise a question for a human when you lack a value you need — NEVER guess or fabricate. " +
      "Parks the task as 'needs_input' and writes the question to the board (visible via get_task " +
      "and board_report). Returns a question_id; then call await_answer to wait for the reply.",
    inputSchema: {
      task_id: z.number().int(),
      text: z.string().min(1).describe("The question to ask the human"),
      options: z.array(z.string()).optional().describe("Optional multiple-choice answers"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(86_400_000)
        .optional()
        .describe("How long to wait before the question times out and the task parks blocked (default 30m, max 24h)"),
    },
  },
  async ({ task_id, text, options, timeout_ms }) => {
    const task = repo.getTask(task_id);
    if (!task) return fail(`Task ${task_id} not found`);
    // A question can only be raised on a task being actively worked (claimed = in_progress),
    // so a stale/duplicate ask can't resurrect a finished/unclaimed task into needs_input.
    if (task.status !== "in_progress" && task.status !== "needs_input") {
      return fail(
        `can only ask on a task being worked (status is '${task.status}', expected in_progress); claim it first`,
      );
    }
    const q = repo.askQuestion(task_id, text, options, timeout_ms);
    if (!q) return fail(`Task ${task_id} not found`);
    return json({ question_id: q.question_id, task_id, status: q.status, deadline_at: q.deadline_at });
  },
);

server.registerTool(
  "answer_task_question",
  {
    title: "Answer a Task's Question",
    description:
      "Answer a question a worker raised (see needs_input tasks / board_report). Matched by " +
      "question_id so a stale answer can't apply to a new question. Records the answer and resumes " +
      "the waiting worker (task returns to in_progress).",
    inputSchema: {
      task_id: z.number().int(),
      question_id: z.string().describe("The question_id from get_task.pending_question / board_report"),
      answer: z.string().min(1),
    },
  },
  async ({ task_id, question_id, answer }) => {
    const res = repo.answerQuestion(task_id, question_id, answer);
    if (!res.ok) return fail(res.error);
    return json({ task_id, question_id, recorded: true, alreadyAnswered: res.alreadyAnswered });
  },
);

server.registerTool(
  "await_answer",
  {
    title: "Await an Answer (worker blocks here)",
    description:
      "Block until the question is answered, or report back so you can call again. Returns " +
      "{status:'answered', answer} when answered, {status:'timed_out'} once past the deadline " +
      "(the task is then parked blocked — do NOT proceed or guess), or {status:'waiting'} after " +
      "the poll window (call await_answer again). The worker's wait loop after ask_question.",
    inputSchema: {
      task_id: z.number().int(),
      question_id: z.string(),
      wait_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Per-call poll window (default ${AWAIT_CHUNK_DEFAULT_MS}ms, capped ${AWAIT_CHUNK_MAX_MS}ms)`),
    },
  },
  async ({ question_id, wait_ms }) => {
    const window = Math.min(wait_ms ?? AWAIT_CHUNK_DEFAULT_MS, AWAIT_CHUNK_MAX_MS);
    // Poll the shared DB: the answer arrives from ANOTHER client's answer_task_question.
    const settled = await awaitPoll(window, () => {
      const st = repo.questionState(question_id);
      if (st.status === "unknown") return fail(`no question '${question_id}'`);
      if (st.status === "answered") return json({ status: "answered", answer: st.answer ?? "" });
      if (st.status === "timed_out") {
        return json({
          status: "timed_out",
          note: "question timed out — task parked blocked; do not fabricate an answer",
        });
      }
      return null;
    });
    return settled ?? json({ status: "waiting", note: "no answer yet — call await_answer again" });
  },
);

server.registerTool(
  "await_task",
  {
    title: "Await Task Completion (blocks here)",
    description:
      "Block until task #task_id settles, then return it — the way to 'hook' back into your turn " +
      "the moment Bob finishes. Returns {status:'done'|'analysis_done', result} on success, " +
      "{status:'blocked'|'cancelled', result} when Bob stopped without completing, " +
      "{status:'needs_input', question} when Bob is waiting on a board question (answer it with " +
      "answer_task_question, then call await_task again), or {status:'waiting', current} after the " +
      "poll window (call await_task again). Polls the shared board; the result is written by Bob's " +
      "worker. Use after dispatching a task you want to act on as soon as it's done. PREFER this over " +
      "looping on list_tasks/board_status/get_task to watch a task — it blocks server-side until the " +
      "settling write lands and hands back needs_input questions to answer, so you should NOT poll the " +
      "board by hand. Requires something draining the board — a 1.x worker process or the 2.0 in-process " +
      "loop; check board_status.worker_draining first (it reflects both).",
    inputSchema: {
      task_id: z.number().int(),
      wait_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Per-call poll window (default ${AWAIT_CHUNK_DEFAULT_MS}ms, capped ${AWAIT_CHUNK_MAX_MS}ms)`),
    },
  },
  async ({ task_id, wait_ms }) => {
    const window = Math.min(wait_ms ?? AWAIT_CHUNK_DEFAULT_MS, AWAIT_CHUNK_MAX_MS);
    // Poll the shared board: the settling write arrives from Bob's worker (another client).
    let lastStatus: TaskStatus | undefined;
    const settled = await awaitPoll(window, () => {
      const o = awaitTaskOutcome(task_id);
      switch (o.kind) {
        case "missing":
          return fail(`no task '#${task_id}'`);
        case "settled":
          return json({ status: o.status, result: o.result });
        case "needs_input":
          // Not "finished" — Bob is parked on a board question; surface it so the caller can answer
          // and await_task again, rather than block until the question's own timeout.
          return json({
            status: "needs_input",
            question: o.question,
            note: "Bob is waiting on a board question — answer with answer_task_question, then call await_task again.",
          });
        case "unsettled":
          lastStatus = o.status;
          return null;
      }
    });
    return (
      settled ?? json({ status: "waiting", current: lastStatus, note: "task not settled yet — call await_task again" })
    );
  },
);

// ---------------------------------------------------------------------------
// Management (foreman / triage)
// ---------------------------------------------------------------------------

server.registerTool(
  "set_task_mode",
  {
    title: "Set Task Mode",
    description:
      "Set or clear a task's Bob mode slug. Pass an empty string to clear it and let the dispatcher auto-route.",
    inputSchema: {
      id: z.number().int(),
      mode: z.string().describe("Mode slug ('code' | 'advanced' | 'ask' | 'orchestrator' | custom), or '' to clear"),
    },
  },
  async ({ id, mode }) => {
    const task = repo.setMode(id, mode.trim() ? mode.trim() : null);
    if (!task) return fail(`Task ${id} not found`);
    return json(task);
  },
);

server.registerTool(
  "set_task_dependencies",
  {
    title: "Set Task Dependencies",
    description:
      "Set or clear a task's dependencies. All dependencies must be 'done' before the task is eligible. Pass an empty array to clear dependencies.",
    inputSchema: {
      id: z.number().int().describe("Task id"),
      depends_on: z.array(z.number().int()).describe("Task IDs this task depends on (empty array clears dependencies)"),
    },
  },
  async ({ id, depends_on }) => {
    try {
      const task = repo.setDependencies(id, depends_on);
      if (!task) return fail(`Task ${id} not found`);
      return json(task);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  "delete_task",
  {
    title: "Delete Task",
    description:
      "Delete a task and its notes. DELETE IS NOT UNDO: if the task already ran and recorded " +
      "artifacts (files written, commits), this refuses and lists the orphaned paths unless " +
      "force:true (delete the record anyway) or cleanup:true (also remove the files). Prefer " +
      "update_task_status 'cancelled' to keep a record.",
    inputSchema: {
      id: z.number().int().describe("Task id"),
      force: z.boolean().optional().describe("Delete the record even if it has recorded artifacts"),
      cleanup: z.boolean().optional().describe("Also unlink the files the task wrote, then delete"),
    },
  },
  async ({ id, force, cleanup }) => json({ id, ...(await deleteTaskAndCheckpoint(id, { force, cleanup })) }),
);

// ---------------------------------------------------------------------------
// Dispatch gate + curation (anti-race)
// ---------------------------------------------------------------------------

server.registerTool(
  "disarm_board",
  {
    title: "Disarm Board (pause dispatch)",
    description:
      "Pause all dispatch: while disarmed, no worker can pull or claim any task. Use before a " +
      "bulk-create/triage so nothing is grabbed mid-curation, then arm_board when ready.",
    inputSchema: { reason: z.string().optional().describe("Why dispatch is paused (shown in board_status)") },
  },
  async ({ reason }) => {
    repo.setBoardArmed(false, reason);
    return json({ armed: false, reason: reason ?? null });
  },
);

server.registerTool(
  "arm_board",
  {
    title: "Arm Board (resume dispatch)",
    description: "Resume dispatch: workers may pull/claim pending tasks again.",
    inputSchema: {},
  },
  async () => {
    repo.setBoardArmed(true);
    return json({ armed: true });
  },
);

server.registerTool(
  "release_tasks",
  {
    title: "Release Staged Tasks",
    description:
      "Move staged tasks to pending so workers can pull them. Optionally filter by ids and/or tag. " +
      "With no filter, releases every staged task. The deliberate 'arm' step after curation.",
    inputSchema: {
      ids: z.array(z.number().int()).optional().describe("Only release these task ids"),
      tag: z.string().optional().describe("Only release staged tasks carrying this tag"),
    },
  },
  async ({ ids, tag }) => json({ released: repo.releaseTasks({ ids, tag }) }),
);

server.registerTool(
  "board_status",
  {
    title: "Board Status",
    description:
      "Dispatch state, counts, and the live task list: whether the board is `armed`, task `counts` by " +
      "status, whether a drainer is currently servicing the board " +
      "(`worker_draining` — a live heartbeat from either a 1.x worker process or the 2.0 in-process " +
      "loop, with `.tags` = the --tag each live worker drains, null = an unfiltered worker that drains " +
      "all tags, and `.last_dispatch` = the freshest dispatch outcome among live workers " +
      "({status, detail, seconds_ago}, null if none yet) — a health signal beyond mere liveness: a " +
      "logged-out/failing Bob keeps beating, so a `last_dispatch.status` of 'aborted' means the drainer " +
      "is alive but not completing work (warn before dispatching)), `worker_leases` (which checkout each live worker owns), " +
      "and `open_tasks` — the non-terminal tasks (staged / " +
      "pending / in_progress / needs_input / blocked) as compact {id,title,status,mode,tags,priority} " +
      "rows for deduping before create_task (capped; see open_tasks_truncated). Check " +
      "`worker_draining.draining` before await_task: if false, nothing is draining the board, so don't " +
      "block — start a drainer first (open the repo in a Bob 2.0 window, or run a 1.x worker). And if " +
      "draining is true but no entry in `worker_draining.tags` is null or matches your task's tags, a " +
      "tag-pinned worker still won't pull it. " +
      "Also check before a bulk-create.",
    inputSchema: {},
  },
  async () => {
    repo.expireOverdueQuestions(); // sweep so a stuck needs_input doesn't linger past its deadline
    const tasks = repo.listTasks({});
    // Reuse the tasks we just loaded for counts — no extra query.
    const { open_tasks, truncated } = repo.selectOpenTasks(tasks, OPEN_TASKS_CAP);
    return json({
      armed: repo.isBoardArmed(),
      worker_draining: repo.getWorkerLiveness(),
      worker_leases: repo.getWorkerLeases(), // T7: which worktree each live worker owns
      counts: repo.countByStatus(tasks),
      total: tasks.length,
      open_tasks,
      open_tasks_truncated: truncated,
    });
  },
);

server.registerTool(
  "record_artifact",
  {
    title: "Record Artifact",
    description:
      "Record a side effect a worker produced for a task: a file written (kind 'file' + path), a " +
      "commit (kind 'commit' + detail=sha), or a test result (kind 'test' + detail). Artifacts make " +
      "delete safe and let an implementation task reach 'done' with evidence.",
    inputSchema: {
      id: z.number().int().describe("Task id"),
      kind: z.enum(ARTIFACT_KINDS),
      path: z.string().optional().describe("Filesystem path for kind 'file' (absolute is best, for cleanup)"),
      detail: z.string().optional().describe("Commit sha, test summary, or diffstat"),
    },
  },
  async ({ id, kind, path, detail }) => {
    const a = repo.recordArtifact(id, { kind, path, detail });
    if (!a) return fail(`Task ${id} not found`);
    return json(a);
  },
);

server.registerTool(
  "board_report",
  {
    title: "Board Report",
    description:
      "Render the board as a markdown standup/audit: tasks grouped by status in pull order, each with age, idle time, latest note, and a stalled flag for long-running in_progress work. Optionally filter to one status.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional().describe("Restrict the report to a single status group"),
    },
  },
  async ({ status }) => {
    repo.expireOverdueQuestions();
    const tasks = repo.listTasks({});
    const notes = new Map(tasks.map((t) => [t.id, repo.getNotes(t.id)]));
    const openQuestions = new Map(
      repo.listOpenQuestions().map((q) => [q.task_id, { text: q.text, options: q.options }]),
    );
    return { content: [{ type: "text", text: buildReport(tasks, notes, Date.now(), { status, openQuestions }) }] };
  },
);

server.registerTool(
  "revert_task",
  {
    title: "Revert a Task (roll back to its checkpoint)",
    description:
      "Restore the working tree to the task's pre-task checkpoint — undo what the task changed. " +
      "Requires a checkpoint, which the worker captures by default but CONSUMES on completion (a " +
      "failed dispatch preserves its WIP to branch bob/task-<id> instead), so this works only while " +
      "one still exists. REFUSES if this server's repo isn't the one the task edited, or if HEAD moved " +
      "since capture (pass force to override). The pre-revert state is pinned to a recovery ref. " +
      "Restores tracked files (HEAD untouched) and removes files the task created.",
    inputSchema: {
      id: z.number().int(),
      force: z.boolean().optional().describe("Revert even if HEAD moved since the checkpoint"),
    },
  },
  async ({ id, force }) => {
    const r = await revertTaskToCheckpoint(process.cwd(), id, "human", { force });
    if (r === null)
      return fail(
        `Task ${id} has no checkpoint — it's consumed once the task completes; a failed dispatch's work is preserved to branch bob/task-${id}`,
      );
    if (!r.reverted) return fail(r.note);
    return json({ id, reverted: true, removed: r.removed, recoveryRef: r.recoveryRef ?? null, note: r.note });
  },
);

async function main(): Promise<void> {
  // Open the DB up front so schema errors surface at startup, not first call.
  repo.getDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[bob-control] MCP server ready on stdio");
  console.error(`[bob-control] board: ${repo.defaultDbPath()}`);
}

main().catch((err) => {
  console.error("[bob-control] fatal:", err);
  process.exit(1);
});
