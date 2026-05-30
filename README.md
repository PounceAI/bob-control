# IBM Bob Task Connector

An MCP server that provisions tasks for [IBM Bob](https://www.ibm.com/products/ai-coding-agent)
(IBM's AI coding agent for IBM i) and other MCP-capable agents. It keeps a small
SQLite task board: you queue work, Bob pulls it, logs progress, and writes back
results. Bob is the MCP client; this is the server it connects to.

## Setup

```powershell
npm install --ignore-scripts
npm run build
npm run smoke      # optional self-test
```

Needs Node 22.5+ (uses the built-in `node:sqlite`, so there's no native build
step). The board lives at `data/tasks.db`; override with `BOB_TASKS_DB`.

## Connecting Bob

Bob reads project MCP servers from `.bob/mcp.json`. Copy the template and point
it at your clone:

```powershell
cp .bob/mcp.json.example .bob/mcp.json
# edit the three /absolute/path/to/ibm-bob-connector paths
```

Bob hot-reloads `.bob/mcp.json` on save and lists `bob-tasks` under the MCP
Servers panel's Project tab. To make it available in every workspace, put the
same `mcpServers` block in the global file instead:

```
%APPDATA%\IBM Bob\User\globalStorage\ibm.bob-code\settings\mcp_settings.json
```

## Tools

| Tool | Purpose |
| ---- | ------- |
| `create_task` | Add a task |
| `list_tasks` | List tasks, filter by status/tag |
| `get_task` | One task plus its notes |
| `get_next_task` | Highest-priority pending task; optionally claim it |
| `claim_task` | Mark in_progress and assign |
| `update_task_status` | pending / in_progress / blocked / done / cancelled |
| `add_task_note` | Append a progress note |
| `submit_result` | Attach a result and mark done |

A typical Bob loop: `get_next_task {claim:true}` then `add_task_note` while
working, then `submit_result`.

## CLI

The CLI shares the same store:

```powershell
node dist/cli.js create "Modernize INVRPT report" --priority high --tags rpg
node dist/cli.js list --status pending --tag rpg
node dist/cli.js show 1
node dist/cli.js claim 1 --assignee bob
node dist/cli.js note 1 "Waiting on test data"
node dist/cli.js result 1 "Done; 3 procedures extracted"
node dist/cli.js stats
```

## Modes

Bob runs in modes: `code`, `advanced` (code plus MCP/browser), `ask`
(read-only), and `orchestrator`. A task can carry a mode; on dispatch the
connector passes it to Bob. Leave it blank and the router in
[src/modes.ts](src/modes.ts) picks one from the title, description, and tags.

```powershell
node dist/cli.js create "Explain the IPC envelope"   # routes to ask
node dist/cli.js create "Fix bug in db.ts"           # routes to code
node dist/cli.js create "Add export" --mode code     # explicit
node dist/cli.js route 1                             # preview the routed mode
```

Precedence: explicit mode, then a tag naming a mode, then the keyword router,
then `code`.

## Worker

The worker drains the board one task at a time: pull the next pending task,
route it, dispatch to Bob in the sidebar, wait for the result, write it back,
mark it done.

```powershell
npm run worker              # drain, then idle-poll
node dist/worker.js --once  # one task then exit
node dist/worker.js --tag rpg
node dist/worker.js --dry-run
```

Flags: `--pipe` `--poll` `--timeout` `--assignee` `--new-tab`
`--max-risk <safe|standard|elevated>` `--no-notify`. Needs Bob running with IPC
enabled (see below). Aborted or timed-out tasks are parked as `blocked`.

Each mode has a risk level, and the worker only dispatches tasks at or below
`--max-risk` (default `standard`); higher-risk ones stay pending for manual
dispatch. The matching auto-approve profile is sent with each dispatch, so an
`ask` task runs read-only regardless of global settings. On finish the worker
pops a tray toast (`--no-notify` to silence; the system sound and terminal bell
are off by default).

### Templates

`create --template <name>` applies a preset mode, priority, tags, and
description scaffold:

```powershell
node dist/cli.js templates
node dist/cli.js create "INVRPT report" --template bug-fix
```

Built-ins: `bug-fix`, `feature`, `research`, `code-review`, `doc`, `refactor`.

## Driving Bob over IPC

Bob starts a `node-ipc` server when launched with `ROO_CODE_IPC_SOCKET_PATH`
set. [bob-control.mjs](bob-control.mjs) connects to it, sends `StartNewTask`,
and streams back Bob's events:

```powershell
node bob-control.mjs "Refactor src/db.ts"
node bob-control.mjs --mode ask "Explain this codebase"
node bob-control.mjs --cancel <taskId>
node bob-control.mjs --list-pipes
```

To enable it, fully quit Bob, then relaunch from the Start menu or
[launch-bob-ipc.cmd](launch-bob-ipc.cmd).

## Task model

`id`, `title`, `description`, `status` (pending/in_progress/blocked/done/cancelled),
`priority` (low/medium/high/urgent), `tags[]`, `mode` (or null to auto-route),
`assignee`, `result`, timestamps, and a per-task notes table.

## Layout

```
src/
  types.ts     task types and enums
  db.ts        SQLite store and repository
  modes.ts     mode slugs, router, per-mode risk profiles
  templates.ts task templates
  bob-ipc.ts   async IPC client (BobClient)
  notify.ts    desktop toast and terminal bell
  server.ts    MCP server (stdio)
  cli.ts       CLI
  worker.ts    auto-dispatch loop
  smoke.ts     self-test
```
