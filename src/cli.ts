#!/usr/bin/env node
import "./suppress-warnings.js";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as repo from "./db.js";
import { TASK_PRIORITIES, TASK_STATUSES, isCompleted, type Task, type TaskStatus } from "./types.js";
import { BUILT_IN_MODES, isBuiltInMode, resolveMode } from "./modes.js";
import { revertTaskToCheckpoint, deleteTaskAndCheckpoint } from "./checkpoint.js";
import { TEMPLATES, getTemplate } from "./templates.js";
import { buildReport } from "./report.js";

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

export function parse(args: string[]): Parsed {
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

function fmtTask(t: Task, showBlocked = false): string {
  const tags = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
  const who = t.assignee ? ` @${t.assignee}` : "";
  const mode = t.mode ? ` {${t.mode}}` : "";
  let blocked = "";

  if (showBlocked && t.depends_on.length > 0) {
    // Check which dependencies are blocking
    const blockingDeps: number[] = [];
    for (const depId of t.depends_on) {
      const dep = repo.getTask(depId);
      // satisfied = isCompleted (done OR analysis_done), mirroring repo.blockingDependencies.
      if (!dep || !isCompleted(dep.status)) {
        blockingDeps.push(depId);
      }
    }
    if (blockingDeps.length > 0) {
      blocked = ` (blocked on ${blockingDeps.map((id) => `#${id}`).join(", ")})`;
    }
  }

  return `#${t.id} (${t.priority}/${t.status})${who}${mode} ${t.title}${tags}${blocked}`;
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
  create <title> [--desc <text>] [--priority low|medium|high|urgent] [--tags a,b,c] [--mode <slug>] [--template <name>] [--depends-on <id,id,...>] [--staged]
  templates                                list available task templates
  list [--status <status>] [--tag <tag>] [--limit <n>]
  show <id>
  claim <id> [--assignee <name>]
  status <id> <${TASK_STATUSES.join("|")}>
  mode <id> <slug>                         set the Bob mode for a task ('' to clear)
  deps <id> <id,id,...>                    set task dependencies (empty string clears)
  route <id>                               show which mode the auto-router would pick
  next                                     show the next pending task the worker would pull, and its routed mode
  note <id> <text> [--author <name>]
  questions                                list open questions awaiting a human answer
  answer <id> <question_id> <text>         answer a worker's board question (resumes the worker)
  result <id> <text> [--open]
  delete <id> [--force] [--cleanup]        refuses if the task recorded artifacts; --force deletes anyway, --cleanup also removes files
  revert <id> [--force]                    roll the working tree back to the task's pre-task checkpoint (needs --checkpoint run; --force if HEAD moved)
  disarm [reason...]                       pause dispatch (no worker pulls until armed)
  arm                                      resume dispatch
  release [ids...] [--tag <tag>]           move staged tasks to pending (all if no filter)
  board                                    show dispatch state (armed?) and status counts
  stats
  report [--status <status>] [--out <file>] [--limit <n>]   markdown standup/audit of the board
  help

Modes: ${BUILT_IN_MODES.join(" | ")} (or any custom mode slug). Omit --mode to auto-route on dispatch.
`;

async function main(): Promise<void> {
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

      // Parse dependencies
      const depsStr = str(flags["depends-on"]);
      const depends_on = depsStr
        ? depsStr.split(",").map((s) => {
            const id = Number(s.trim());
            if (!Number.isInteger(id)) die(`invalid dependency id '${s}' (must be an integer)`);
            return id;
          })
        : undefined;

      // Template supplies defaults; explicit flags override.
      const tplName = str(flags.template);
      const tpl = tplName ? getTemplate(tplName) : undefined;
      if (tplName && !tpl) {
        die(`unknown template '${tplName}'. Run 'bob-tasks templates'.`);
      }

      const mode = str(flags.mode) ?? tpl?.mode;
      if (mode && !isBuiltInMode(mode)) {
        console.error(
          `warning: '${mode}' is not a built-in mode (${BUILT_IN_MODES.join(", ")}); using it as a custom mode slug`,
        );
      }
      const tags = cliTags ?? tpl?.tags;

      try {
        const task = repo.createTask({
          title,
          description: str(flags.desc) ?? str(flags.description) ?? tpl?.scaffold(title) ?? null,
          priority: (priority as Task["priority"] | undefined) ?? tpl?.priority,
          tags,
          mode: mode ?? null,
          depends_on,
          staged: flags.staged === true,
        });
        console.log(`created ${fmtTask(task)}`);
      } catch (err) {
        die((err as Error).message);
      }
      break;
    }

    case "templates": {
      console.log('Task templates (use with: create "<subject>" --template <name>):\n');
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
      // Show blocked status for pending tasks
      const showBlocked = !status || status === "pending";
      for (const t of tasks) console.log(fmtTask(t, showBlocked));
      break;
    }

    case "show": {
      const id = requireId(positional);
      const task = repo.getTask(id);
      if (!task) die(`task ${id} not found`);
      // Always JSON; --json just controls indentation.
      console.log(
        JSON.stringify(
          { ...task, notes: repo.getNotes(id), pending_question: repo.getOpenQuestion(id) },
          null,
          flags.json === true ? 0 : 2,
        ),
      );
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
      // 'staged'/'needs_input' aren't arbitrary transitions: staged would resurrect the pull
      // race; needs_input must carry a real question (only ask_question sets it).
      if (status === "staged" || status === "needs_input") {
        die(
          `cannot move a task to '${status}' via status; ${status === "staged" ? "create with --staged / use 'release'" : "questions are raised by a worker, not set here"}`,
        );
      }
      if (!repo.getTask(id)) die(`task ${id} not found`);
      const task = repo.updateStatus(id, status as Task["status"]);
      if (status === "done" && !repo.hasEvidence(id)) {
        console.error(
          "warning: marked done without recorded execution evidence (unverified); prefer 'result' with evidence, or use 'analysis_done'",
        );
      }
      console.log(`updated ${fmtTask(task!)}`);
      break;
    }

    case "mode": {
      const id = requireId(positional);
      const slug = positional[1] ?? "";
      if (slug && !isBuiltInMode(slug)) {
        console.error(
          `warning: '${slug}' is not a built-in mode (${BUILT_IN_MODES.join(", ")}); using it as a custom mode slug`,
        );
      }
      const task = repo.setMode(id, slug || null);
      if (!task) die(`task ${id} not found`);
      console.log(slug ? `set mode {${slug}} on ${fmtTask(task)}` : `cleared mode on ${fmtTask(task)}`);
      break;
    }

    case "deps": {
      const id = requireId(positional);
      const depsStr = positional[1] ?? "";
      const depends_on = depsStr
        ? depsStr.split(",").map((s) => {
            const depId = Number(s.trim());
            if (!Number.isInteger(depId)) die(`invalid dependency id '${s}' (must be an integer)`);
            return depId;
          })
        : [];

      try {
        const task = repo.setDependencies(id, depends_on);
        if (!task) die(`task ${id} not found`);
        if (depends_on.length) {
          console.log(`set dependencies [${depends_on.map((d) => `#${d}`).join(", ")}] on ${fmtTask(task)}`);
        } else {
          console.log(`cleared dependencies on ${fmtTask(task)}`);
        }
      } catch (err) {
        die((err as Error).message);
      }
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
      // Armed-aware pull: matches what the worker would actually pull (nothing while disarmed).
      const task = repo.nextTask();
      if (!task) {
        console.log(repo.isBoardArmed() ? "(no pending tasks)" : "(board disarmed — dispatch paused)");
        break;
      }
      const { mode } = resolveMode(task);
      console.log(`${fmtTask(task, true)} -> {${mode}}`);
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

    case "questions": {
      const open = repo.listOpenQuestions();
      if (!open.length) {
        console.log("(no open questions)");
        break;
      }
      for (const q of open) {
        const opts = q.options.length ? `  options: ${q.options.join(" | ")}` : "";
        console.log(`#${q.task_id} [${q.question_id}] ${q.text}${opts}`);
      }
      break;
    }

    case "answer": {
      const id = requireId(positional);
      const questionId = positional[1];
      // Join the rest so a multi-word answer isn't truncated to its first token (an answer
      // is almost always multi-word, and a corrupted answer is exactly what we must avoid).
      const text = positional.slice(2).join(" ");
      if (!questionId || !text) die("answer requires <task_id> <question_id> <text>");
      const res = repo.answerQuestion(id, questionId, text);
      if (!res.ok) die(res.error);
      console.log(
        res.alreadyAnswered
          ? `question [${questionId}] was already answered`
          : `answered [${questionId}] on #${id} — waiting worker resumes`,
      );
      break;
    }

    case "result": {
      const id = requireId(positional);
      const text = positional[1];
      if (!text) die("result requires text");
      const markDone = flags.open !== true;
      const task = repo.setResult(id, text, markDone);
      if (!task) die(`task ${id} not found`);
      if (markDone && !repo.hasEvidence(id)) {
        console.error(
          "warning: marked done without recorded execution evidence (unverified); use --open to keep it open, or record evidence",
        );
      }
      console.log(`result saved for ${fmtTask(task)}`);
      break;
    }

    case "delete": {
      const id = requireId(positional);
      const r = await deleteTaskAndCheckpoint(id, { force: flags.force === true, cleanup: flags.cleanup === true });
      if (!r.deleted) {
        die(r.warning ?? `task ${id} not found`);
      }
      const cleaned = r.cleaned?.length ? ` (removed ${r.cleaned.length} file(s))` : "";
      console.log(`deleted #${id}${cleaned}`);
      break;
    }

    case "revert": {
      const id = requireId(positional);
      const r = await revertTaskToCheckpoint(process.cwd(), id, "me", { force: flags.force === true });
      if (r === null) die(`task ${id} has no checkpoint (run the worker with --checkpoint to capture one)`);
      if (!r.reverted) die(r.note);
      const removed = r.removed.length ? `, removed ${r.removed.length} created file(s)` : "";
      const recovery = r.recoveryRef ? ` (recovery snapshot: ${r.recoveryRef})` : "";
      console.log(`reverted #${id} to its pre-task checkpoint${removed}${recovery}`);
      break;
    }

    case "disarm": {
      repo.setBoardArmed(false, positional.join(" ") || undefined);
      console.log("board disarmed — dispatch paused (run 'arm' to resume)");
      break;
    }

    case "arm": {
      repo.setBoardArmed(true);
      console.log("board armed — dispatch resumed");
      break;
    }

    case "release": {
      const ids = positional.length
        ? positional.map((s) => {
            const n = Number(s);
            if (!Number.isInteger(n)) die(`invalid task id '${s}'`);
            return n;
          })
        : undefined;
      const n = repo.releaseTasks({ ids, tag: str(flags.tag) });
      console.log(`released ${n} staged task(s) to pending`);
      break;
    }

    case "board": {
      const counts = repo.countByStatus(repo.listTasks({}));
      console.log(`armed: ${repo.isBoardArmed()}`);
      for (const s of TASK_STATUSES) if (counts[s]) console.log(`  ${s}: ${counts[s]}`);
      break;
    }

    case "stats": {
      const allTasks = repo.listTasks({});
      const counts = repo.countByStatus(allTasks);
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

    case "report": {
      const status = str(flags.status);
      if (status && !TASK_STATUSES.includes(status as never)) {
        die(`invalid status '${status}' (use ${TASK_STATUSES.join(", ")})`);
      }
      const limitStr = str(flags.limit);
      const limit = limitStr ? Number(limitStr) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        die("--limit must be a positive integer");
      }
      const tasks = repo.listTasks({});
      const notes = new Map(tasks.map((t) => [t.id, repo.getNotes(t.id)]));
      const openQuestions = new Map(
        repo.listOpenQuestions().map((q) => [q.task_id, { text: q.text, options: q.options }]),
      );
      const md = buildReport(tasks, notes, Date.now(), {
        status: status as TaskStatus | undefined,
        limit,
        openQuestions,
      });
      const out = str(flags.out);
      if (out) {
        writeFileSync(out, md);
        console.log(`wrote report to ${out} (${tasks.length} tasks)`);
      } else {
        console.log(md);
      }
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

// Run the CLI only when invoked as a script (node dist/cli.js …), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  });
}
