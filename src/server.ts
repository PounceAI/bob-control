import "./suppress-warnings.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as repo from "./db.js";
import { TASK_STATUSES, TASK_PRIORITIES } from "./types.js";
import { buildReport } from "./report.js";

// IBM Bob Task Connector MCP server. Bob connects and gets tools to pull, claim,
// log, and complete tasks; work is provisioned via create_task or the CLI and
// persisted in local SQLite.
//
// stdio server: stdout is reserved for the MCP protocol, so all logging goes to
// stderr via console.error.

const server = new McpServer({
  name: "ibm-bob-task-connector",
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
    },
  },
  async ({ title, description, priority, tags, mode }) =>
    json(repo.createTask({ title, description, priority, tags, mode })),
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
    if (!task) return json(null);
    if (claim) return json(repo.claimTask(task.id, assignee ?? "bob"));
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
    const task = repo.claimTask(id, assignee ?? "bob");
    if (!task) return fail(`Task ${id} not found`);
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
    const task = repo.updateStatus(id, status);
    if (!task) return fail(`Task ${id} not found`);
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
      "Attach a result / summary to a task. Marks it done unless mark_done is set to false.",
    inputSchema: {
      id: z.number().int(),
      result: z.string().min(1),
      mark_done: z.boolean().optional().describe("Mark task done (default: true)"),
    },
  },
  async ({ id, result, mark_done }) => {
    const task = repo.setResult(id, result, mark_done ?? true);
    if (!task) return fail(`Task ${id} not found`);
    return json(task);
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
  "delete_task",
  {
    title: "Delete Task",
    description:
      "Permanently delete a task and its notes. Use for duplicates or mistakes; prefer update_task_status 'cancelled' when you want to keep a record.",
    inputSchema: { id: z.number().int().describe("Task id") },
  },
  async ({ id }) => json({ id, deleted: repo.deleteTask(id) }),
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
  console.error("[ibm-bob-task-connector] MCP server ready on stdio");
  console.error(`[ibm-bob-task-connector] board: ${repo.defaultDbPath()}`);
}

main().catch((err) => {
  console.error("[ibm-bob-task-connector] fatal:", err);
  process.exit(1);
});
