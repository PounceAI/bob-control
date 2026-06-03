import "./suppress-warnings.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as repo from "./db.js";
import { TASK_STATUSES, TASK_PRIORITIES, ARTIFACT_KINDS } from "./types.js";
import { resolveMode, isReadOnlyMode } from "./modes.js";
import { buildReport } from "./report.js";

const WORKER_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** Heuristic: a drainer looks active if any task is in_progress with a recent touch. */
function workerLikelyActive(): boolean {
  const now = Date.now();
  return repo
    .listTasks({ status: "in_progress" })
    .some((t) => now - Date.parse(t.updated_at) < WORKER_ACTIVE_WINDOW_MS);
}

// Bob Control MCP server. Bob connects and gets tools to pull, claim,
// log, and complete tasks; work is provisioned via create_task or the CLI and
// persisted in local SQLite.
//
// stdio server: stdout is reserved for the MCP protocol, so all logging goes to
// stderr via console.error.

const server = new McpServer({
  name: "bob-control",
  version: "0.1.0",
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

// ---------------------------------------------------------------------------
// Provisioning (used by you / Claude, also available to Bob)
// ---------------------------------------------------------------------------

server.registerTool(
  "create_task",
  {
    title: "Create Task",
    description:
      "Provision a new task for Bob to work on. Returns the created task including its id.",
    inputSchema: {
      title: z.string().min(1).describe("Short, action-oriented task title"),
      description: z
        .string()
        .optional()
        .describe("Detailed instructions, context, and acceptance criteria"),
      priority: z
        .enum(TASK_PRIORITIES)
        .optional()
        .describe("Priority bucket (default: medium)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Labels for filtering, e.g. ['rpg','refactor']"),
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
      // Warn when a pullable task drops onto a live board (bulk-create race, incident A).
      if (!staged && repo.isBoardArmed() && workerLikelyActive()) {
        return json({
          ...task,
          warning:
            "Board is ARMED and a worker looks active — this task may be pulled before you finish curating. " +
            "Disarm the board (disarm_board) or create staged:true while bulk-creating, then release_tasks.",
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
    description:
      "List tasks, optionally filtered by status and/or tag. Ordered by priority, then oldest first.",
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
    return json({ ...task, notes: repo.getNotes(id) });
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
      claim: z
        .boolean()
        .optional()
        .describe("If true, immediately mark the task in_progress and assign it"),
      assignee: z.string().optional().describe("Who is taking the task (default: 'bob')"),
    },
  },
  async ({ tag, claim, assignee }) => {
    const task = repo.nextTask({ tag });
    // null also means the board is disarmed — say so rather than look empty.
    if (!task) {
      if (!repo.isBoardArmed()) return json({ task: null, board: "disarmed", note: "dispatch is paused; arm the board to pull" });
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
    // 'staged' isn't an arbitrary transition (would reopen the pull race) — use create/release_tasks.
    if (status === "staged") {
      return fail("cannot move a task to 'staged'; create with staged:true, or use release_tasks to unstage");
    }
    const task = repo.updateStatus(id, status);
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
      mode: z
        .string()
        .describe("Mode slug ('code' | 'advanced' | 'ask' | 'orchestrator' | custom), or '' to clear"),
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
      depends_on: z
        .array(z.number().int())
        .describe("Task IDs this task depends on (empty array clears dependencies)"),
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
  async ({ id, force, cleanup }) => json({ id, ...repo.deleteTaskSafe(id, { force, cleanup }) }),
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
      "Dispatch state and counts: whether the board is armed, task counts by status, and whether " +
      "a worker looks active. Check before a bulk-create so you don't drop tasks onto a live board.",
    inputSchema: {},
  },
  async () => {
    const tasks = repo.listTasks({});
    return json({
      armed: repo.isBoardArmed(),
      worker_likely_active: workerLikelyActive(),
      counts: repo.countByStatus(tasks),
      total: tasks.length,
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
    const tasks = repo.listTasks({});
    const notes = new Map(tasks.map((t) => [t.id, repo.getNotes(t.id)]));
    return { content: [{ type: "text", text: buildReport(tasks, notes, Date.now(), { status }) }] };
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
