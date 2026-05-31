#!/usr/bin/env node
import "./suppress-warnings.js";
import * as repo from "./db.js";
import { TASK_PRIORITIES, TASK_STATUSES, type Task } from "./types.js";
import { BUILT_IN_MODES, isBuiltInMode, resolveMode } from "./modes.js";
import { TEMPLATES, getTemplate } from "./templates.js";

/**
 * bob-tasks: CLI for provisioning and inspecting tasks in the same SQLite
 * store the MCP server uses. Run after `npm run build`:
 *
 *   node dist/cli.js create "Title" --desc "..." --priority high --tags rpg,sql
 *   node dist/cli.js list [--status pending] [--tag rpg]
 *   node dist/cli.js show <id>
 *   node dist/cli.js claim <id> [--assignee bob]
 *   node dist/cli.js status <id> <status>
 *   node dist/cli.js note <id> "text" [--author me]
 *   node dist/cli.js result <id> "text" [--open]   (--open = don't mark done)
 *   node dist/cli.js delete <id>
 */

interface Parsed {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parse(args: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fmtTask(t: Task): string {
  const tags = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
  const who = t.assignee ? ` @${t.assignee}` : "";
  const mode = t.mode ? ` {${t.mode}}` : "";
  return `#${t.id} (${t.priority}/${t.status})${who}${mode} ${t.title}${tags}`;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function requireId(positional: string[]): number {
  const id = Number(positional[0]);
  if (!Number.isInteger(id)) die("a numeric task id is required");
  return id;
}

const HELP = `bob-tasks — provision tasks for IBM Bob

Commands:
  create <title> [--desc <text>] [--priority low|medium|high|urgent] [--tags a,b,c] [--mode <slug>] [--template <name>]
  templates                                list available task templates
  list [--status <status>] [--tag <tag>] [--limit <n>]
  show <id>
  claim <id> [--assignee <name>]
  status <id> <${TASK_STATUSES.join("|")}>
  mode <id> <slug>                         set the Bob mode for a task ('' to clear)
  route <id>                               show which mode the auto-router would pick
  next                                     show the next pending task the worker would pull, and its routed mode
  note <id> <text> [--author <name>]
  result <id> <text> [--open]
  delete <id>
  stats
  help

Modes: ${BUILT_IN_MODES.join(" | ")} (or any custom mode slug). Omit --mode to auto-route on dispatch.
`;

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parse(rest);

  switch (command) {
    case "create": {
      const title = positional[0];
      if (!title) die('create requires a title, e.g. create "Refactor INVRPT"');
      const priority = str(flags.priority);
      if (priority && !TASK_PRIORITIES.includes(priority as never)) {
        die(`invalid priority '${priority}' (use ${TASK_PRIORITIES.join(", ")})`);
      }
      const cliTags = str(flags.tags)
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // Template supplies defaults; explicit flags override.
      const tplName = str(flags.template);
      const tpl = tplName ? getTemplate(tplName) : undefined;
      if (tplName && !tpl) {
        die(`unknown template '${tplName}'. Run 'bob-tasks templates'.`);
      }

      const mode = str(flags.mode) ?? tpl?.mode;
      if (mode && !isBuiltInMode(mode)) {
        console.error(`warning: '${mode}' is not a built-in mode (${BUILT_IN_MODES.join(", ")}); using it as a custom mode slug`);
      }
      const tags = cliTags ?? tpl?.tags;
      const task = repo.createTask({
        title,
        description:
          str(flags.desc) ?? str(flags.description) ?? tpl?.scaffold(title) ?? null,
        priority: (priority as Task["priority"] | undefined) ?? tpl?.priority,
        tags,
        mode: mode ?? null,
      });
      console.log(`created ${fmtTask(task)}`);
      break;
    }

    case "templates": {
      console.log("Task templates (use with: create \"<subject>\" --template <name>):\n");
      for (const t of TEMPLATES) {
        console.log(`  ${t.name.padEnd(12)} {${t.mode}}/${t.priority}  ${t.about}`);
      }
      break;
    }

    case "list": {
      const status = str(flags.status);
      if (status && !TASK_STATUSES.includes(status as never)) {
        die(`invalid status '${status}' (use ${TASK_STATUSES.join(", ")})`);
      }
      const limit = str(flags.limit) ? Number(str(flags.limit)) : undefined;
      const tasks = repo.listTasks({
        status: status as Task["status"] | undefined,
        tag: str(flags.tag),
        limit,
      });
      if (flags.json === true) {
        console.log(JSON.stringify(tasks));
        break;
      }
      if (!tasks.length) {
        console.log("(no tasks)");
        break;
      }
      for (const t of tasks) console.log(fmtTask(t));
      break;
    }

    case "show": {
      const id = requireId(positional);
      const task = repo.getTask(id);
      if (!task) die(`task ${id} not found`);
      // Always JSON; --json just controls indentation.
      console.log(JSON.stringify({ ...task, notes: repo.getNotes(id) }, null, flags.json === true ? 0 : 2));
      break;
    }

    case "claim": {
      const id = requireId(positional);
      const task = repo.claimTask(id, str(flags.assignee) ?? "bob");
      if (!task) die(`task ${id} not found`);
      console.log(`claimed ${fmtTask(task)}`);
      break;
    }

    case "status": {
      const id = requireId(positional);
      const status = positional[1];
      if (!status || !TASK_STATUSES.includes(status as never)) {
        die(`status must be one of ${TASK_STATUSES.join(", ")}`);
      }
      const task = repo.updateStatus(id, status as Task["status"]);
      if (!task) die(`task ${id} not found`);
      console.log(`updated ${fmtTask(task)}`);
      break;
    }

    case "mode": {
      const id = requireId(positional);
      const slug = positional[1] ?? "";
      if (slug && !isBuiltInMode(slug)) {
        console.error(`warning: '${slug}' is not a built-in mode (${BUILT_IN_MODES.join(", ")}); using it as a custom mode slug`);
      }
      const task = repo.setMode(id, slug || null);
      if (!task) die(`task ${id} not found`);
      console.log(slug ? `set mode {${slug}} on ${fmtTask(task)}` : `cleared mode on ${fmtTask(task)}`);
      break;
    }

    case "route": {
      const id = requireId(positional);
      const task = repo.getTask(id);
      if (!task) die(`task ${id} not found`);
      const { mode, source } = resolveMode(task);
      console.log(`#${id} would dispatch in mode {${mode}} (${source})`);
      break;
    }

    case "next": {
      const [task] = repo.listTasks({ status: "pending", limit: 1 });
      if (!task) {
        console.log("(no pending tasks)");
        break;
      }
      const { mode } = resolveMode(task);
      console.log(`${fmtTask(task)} -> {${mode}}`);
      break;
    }

    case "note": {
      const id = requireId(positional);
      const text = positional[1];
      if (!text) die("note requires text");
      const note = repo.addNote(id, text, str(flags.author) ?? "me");
      if (!note) die(`task ${id} not found`);
      console.log(`noted on #${id}: ${text}`);
      break;
    }

    case "result": {
      const id = requireId(positional);
      const text = positional[1];
      if (!text) die("result requires text");
      const task = repo.setResult(id, text, flags.open !== true);
      if (!task) die(`task ${id} not found`);
      console.log(`result saved for ${fmtTask(task)}`);
      break;
    }

    case "delete": {
      const id = requireId(positional);
      console.log(repo.deleteTask(id) ? `deleted #${id}` : `task ${id} not found`);
      break;
    }

    case "stats": {
      const allTasks = repo.listTasks({});
      const counts: Record<string, number> = {};
      for (const status of TASK_STATUSES) {
        counts[status] = 0;
      }
      for (const task of allTasks) {
        counts[task.status]++;
      }
      if (flags.json === true) {
        console.log(JSON.stringify({ ...counts, total: allTasks.length }));
        break;
      }
      console.log("Task Statistics:");
      for (const status of TASK_STATUSES) {
        console.log(`  ${status}: ${counts[status]}`);
      }
      console.log(`  total: ${allTasks.length}`);
      break;
    }

    case "help":
    case undefined:
      console.log(HELP);
      break;

    default:
      die(`unknown command '${command}'. Run 'bob-tasks help'.`);
  }
}

main();
