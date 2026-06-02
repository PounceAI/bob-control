# IBM Bob Task Connector

An MCP server that provisions tasks for [IBM Bob](https://www.ibm.com/products/ai-coding-agent)
(IBM's AI coding agent for IBM i) and other MCP-capable agents. It keeps a small
SQLite task board: you queue work, Bob pulls it, logs progress, and writes back
results. Bob is the MCP client; this is the server it connects to.

## Setup

```powershell
npm install        # not --ignore-scripts: esbuild's postinstall fetches its binary
npm run build      # tsc -> dist/, then bundles claude-plugin/server/server.mjs
npm run smoke      # optional self-test
```

Needs Node 22.5+ (uses the built-in `node:sqlite`, so there's no native build step).
The board lives at `data/tasks.db`; override with `BOB_TASKS_DB`, or set
`BOB_TASKS_PORTABLE=1` for a shared `~/.bob-tasks/tasks.db` (see the plugin below).

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

## Claude Code companion (plugin)

Because the connector is an MCP server and Claude Code is an MCP client, Claude Code can
work the **same board Bob drains** — as the *foreman* (provision / route / triage) and as
a *worker* (claim and execute tasks itself). It ships as a self-contained Claude Code
plugin in [claude-plugin/](claude-plugin/README.md) so you can use it **from any repo**,
not just this one.

The plugin bundles the connector into a single `server/server.mjs` (esbuild; no native
deps thanks to `node:sqlite`), so install is all that's required — no checkout needed at
runtime. Build it, add the local marketplace, install:

```powershell
npm install && npm run build      # build also bundles claude-plugin/server/server.mjs
# in Claude Code, from anywhere:
#   /plugin marketplace add /absolute/path/to/ibm-bob-connector
#   /plugin install bob-foreman@ibm-bob-connector
```

| Surface | What it does |
| ------- | ------------ |
| `/bob-new <desc>` | Turn a rough ask into one well-formed task (title, criteria, priority, tags, routed mode) |
| `/bob-board [tag]` | The board grouped by status, in pull order |
| `/bob-next [tag]` | What Bob pulls next and the mode it routes to (read-only; never claims) |
| `/bob-route <id\|text>` | Predict the dispatch mode for a task or a hypothetical |
| `/bob-triage [focus]` | Review the board, propose fixes, apply the safe ones on confirm |
| `/bob-review [range]` | Queue a read-only (ask-mode) Bob code review of the diff you just made |
| `/bob-work [tag] [--max N]` | **Worker:** claim pending tasks Claude can do, execute them, submit results |
| `bob-foreman` subagent | Split a large request into several correctly-routed, ordered tasks |

### Shared board

The plugin sets `BOB_TASKS_PORTABLE=1`, which puts the board at a fixed
`~/.bob-tasks/tasks.db` (Windows: `%USERPROFILE%\.bob-tasks\tasks.db`) regardless of which
repo you're in. Set the **same flag** in Bob's `.bob/mcp.json` (`"env": { "BOB_TASKS_PORTABLE":
"1" }`) and both tools share one queue. `/bob-work` claims tasks as `claude` and leaves
IBM-i/RPG work for Bob, so the two never double-work a task. The server logs the resolved
board path on startup. (`BOB_TASKS_DB` still overrides with an explicit path; without either
flag the board stays repo-local at `data/tasks.db`.)

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
| `set_task_mode` | Set or clear a task's mode slug |
| `delete_task` | Permanently delete a task and its notes |
| `board_report` | Markdown standup/audit of the board, grouped by status |

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
node dist/cli.js next                                 # next pending task + its routed mode
node dist/cli.js stats
node dist/cli.js report                               # markdown standup/audit of the board
node dist/cli.js report --status blocked --out report.md
```

`report` groups tasks by status in pull order, each with age, idle time, the
latest note, and a ⚠ stalled flag for in_progress work idle over 30 min — handy
for a standup or spotting wedged tasks. It also prints an audit summary tallying
unattended automation activity from task notes: classifier approvals/denials,
answerer answers/escalations, and human actions (with an estimated classifier
cost). Same output is available to agents via the `board_report` MCP tool.

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
`--max-risk <safe|standard|elevated>` `--no-notify` `--no-defer` `--answer-followups`
`--escalate-all` `--review-plans` `--allow-commands <prefix,prefix>`. Needs Bob running
with IPC enabled (see below).
Aborted or timed-out tasks are parked as `blocked`.

Each mode has a risk level, and the worker only dispatches tasks at or below
`--max-risk` (default `standard`); higher-risk ones stay pending for manual
dispatch. On finish the worker pops a tray toast (`--no-notify` to silence; the
system sound and terminal bell are off by default).

### Unattended execution

Each dispatch sends the mode's auto-approve profile — the `autoApprovalEnabled`
master switch, per-category toggles, and a curated `SAFE_COMMANDS` allowlist — so
Bob runs without stalling on approval prompts. `ask` stays read-only;
`code`/`orchestrator` add writes and auto-run allowlisted commands (build/test/vcs);
anything else still prompts. This per-dispatch profile is enough for the worker on
its own; to apply the same auto-approve to your *interactive* Bob session, fully quit
Bob and launch via [launch-bob-ipc.cmd](launch-bob-ipc.cmd) (it runs
[set-bob-autoapprove.mjs](set-bob-autoapprove.mjs), which writes the same allowlist to
Bob's global state).

For the gray zone (a command not on the allowlist), `code`, `orchestrator`, and
`advanced` modes can hand the decision to Claude instead of a human:

```powershell
node dist/worker.js --command-classifier                             # cli backend: reuses your Claude login, no key
node dist/worker.js --command-classifier --classifier-backend api    # one Anthropic call (needs ANTHROPIC_API_KEY)
```

The classifier presses approve/reject over IPC, which needs a one-time patch that
exposes Bob's buttons — `node tools/patch-bob-buttons.mjs`, then restart Bob. It
engages for any mode with gray-zone commands (`code`, `orchestrator`, `advanced`),
so it works at the default `--max-risk standard`. Fail-safe: only an explicit
"approve" runs a command; any error or timeout leaves it for a human. Extra flags:
`--classifier-backend <cli|api>` `--classifier-model` `--classifier-cli`.

To skip the classifier for commands you already trust in a given drain, extend the
auto-run allowlist with `--allow-commands` (comma-separated command prefixes):

```powershell
node dist/worker.js --allow-commands "npm run lint,git fetch"   # these auto-run, no classifier call
```

The other thing that stalls an unattended task is Bob **asking a question** mid-task
(e.g. "which approach should I take?"). With `--answer-followups`, the worker asks
Claude to answer — preferring one of Bob's offered options — and sends the reply back
over IPC (a native `SendMessage`, so no button patch). It applies in any mode and uses
the same backend as the classifier. Fail-safe: when the answerer is unsure or the
question is consequential (deletes, scope changes), it **escalates to you** (a desktop
toast + a note on the task) instead of guessing.

```powershell
node dist/worker.js --answer-followups                  # Claude answers Bob's questions; escalates when unsure
node dist/worker.js --answer-followups --escalate-all   # escalate ALL questions to you (including plan approvals)
node dist/worker.js --answer-followups --review-plans   # escalate plan/design questions, auto-answer mechanical ones
```

With `--escalate-all`, every followup question is escalated to you for review instead of
being auto-answered — ensuring you see and approve plans/designs before Bob proceeds. Off
by default (Claude answers confident questions); only applies when `--answer-followups` is on.

With `--review-plans`, plan/design-approval questions ("should I proceed with this refactor?",
"which approach should I take?") are escalated to you for review, while mechanical clarifications
("which file?", "flag name -x or -y?") are auto-answered. This is a middle ground between
`--escalate-all` (blocks on every question) and the default (auto-answers everything confident).
### Verify-and-continue with LLM judge

When `--verify-and-continue` is on, the worker runs an acceptance check after Bob completes
a task and loops back to Bob to fix issues until it passes or `--max-continues` is reached.
This catches broken builds/tests without human intervention.

By default, with no `--verify-command` set, the loop blind-passes (no reliable heuristic).
Add `--verify-judge` to use an **LLM judge** that reviews Bob's completion against the task
criteria and actual code changes (git diff). The judge uses the same backend as the command
classifier (reuses your Claude login or ANTHROPIC_API_KEY). The diff is scoped to **this
task's** changes — captured against a pre-dispatch baseline so pre-existing edits in a dirty
tree aren't attributed to the task, and new (untracked) files the task creates are included.

```powershell
node dist/worker.js --verify-and-continue --verify-judge                    # judge is sole verifier
node dist/worker.js --verify-and-continue --verify-command "npm test" --verify-judge  # command first, then judge
node dist/worker.js --verify-and-continue --verify-command "npm test"       # command only, no judge
```

When both `--verify-command` and `--verify-judge` are set, the command runs **first** and must
pass; the judge then provides an **additional gate** (both must pass). When only `--verify-judge`
is set, the judge is the sole acceptance signal. The judge fails safe: any LLM error or timeout
is treated as a pass (logged as a task note) so infrastructure failures never block tasks.

When both `--review-plans` and `--escalate-all` are set, `--review-plans` takes precedence.

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
[launch-bob-ipc.cmd](launch-bob-ipc.cmd) (which also enables auto-approve for
unattended runs — see above).

## Task model

`id`, `title`, `description`, `status` (pending/in_progress/blocked/done/cancelled),
`priority` (low/medium/high/urgent), `tags[]`, `mode` (or null to auto-route),
`assignee`, `result`, timestamps, and a per-task notes table.

## Layout

```
src/
  types.ts        task types and enums
  db.ts           SQLite store and repository
  modes.ts        mode slugs, router, per-mode risk + auto-approve profiles
  templates.ts    task templates
  bob-ipc.ts      async IPC client (BobClient; approve/reject/sendMessage)
  llm.ts          shared Claude transport (api / cli backends)
  classify.ts     command-safety classifier (gray-zone command asks)
  command-gate.ts gray-zone approve/reject gate (worker -> IPC)
  answer.ts       answerer for Bob's followup questions
  followup-gate.ts answer-or-escalate gate for followup asks (worker -> IPC)
  defer.ts        pause dispatch while you're chatting with Bob
  report.ts       board -> markdown standup/audit (CLI + board_report tool)
  notify.ts       desktop toast and terminal bell
  server.ts       MCP server (stdio)
  cli.ts          CLI
  worker.ts       auto-dispatch loop
  smoke.ts        self-test
tools/
  patch-bob-buttons.mjs   expose Bob's approve/reject buttons over IPC
```
