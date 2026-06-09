# Bob Control

[![CI](https://github.com/Joshua-Gilbert/bob-control/actions/workflows/ci.yml/badge.svg)](https://github.com/Joshua-Gilbert/bob-control/actions/workflows/ci.yml)

**What it adds to your stack — and why you should care.** An AI coding agent on its own is a
chat window: you drive it one prompt at a time and babysit every approval. This library turns
it into an **unattended queue worker** — fill a board and each task gets dispatched, auto-approved
inside risk guardrails, answered when the agent asks a question, verified (a command check or an
LLM judge), retried on transient failures, and written back — in dependency order, with no one
watching. You trade *babysitting one task* for *draining a backlog*, while gating and an acceptance
judge keep it honest — and IBM Bob and Claude Code can share one board so each does the work it's
best at. If your stack already has an agent, this is the missing piece that makes it run on its own.

Concretely: an MCP **server** + **CLI** + auto-dispatch **worker** over a SQLite task board.
The worker pulls each task in dependency and priority order and dispatches it to
[IBM Bob](https://www.ibm.com/products/ai-coding-agent) (IBM's AI coding agent for IBM i)
**live over IPC**, streaming back its events. Bob is the MCP client; this is the server it
connects to — and Claude Code speaks the same MCP, so it can work the **same board** as
foreman (provision / route / triage) or worker.

### Where it fits

This is the **runtime execution + orchestration** layer: it actually drives a live agent,
keeps it unattended, and verifies the output. That's a different job from **planning /
governance** CLIs (e.g. [MissionForge](https://github.com/loudiman/Mission-Forge)), which
deterministically *decompose and scope* work but don't run an agent. The two compose — plan
upstream, then queue the pieces here with `depends_on` ordering and let the worker drain them.
What this layer owns that a planning CLI doesn't: live IPC control (dispatch / approve /
answer / cancel), LLM-judged acceptance, a multi-agent shared board, and command/risk gating.

## Setup

```powershell
npm install        # not --ignore-scripts: esbuild's postinstall fetches its binary
npm run build      # tsc -> dist/, then bundles claude-plugin/server/server.mjs
npm run smoke      # optional self-test
```

Needs Node 22.5+ (uses the built-in `node:sqlite`, so there's no native build step).
Board path resolution: `BOB_TASKS_DB` (explicit) › `BOB_TASKS_PORTABLE=1` (a shared
`~/.bob-tasks/tasks.db`) › repo-local `data/tasks.db`. The plugin points each project at
**its own** board (see [Boards are per project](#boards-are-per-project)). On first open the
store also writes a `.gitignore` beside itself, so the board never lands as untracked state
in a consuming repo.

## Connecting Bob

Bob reads project MCP servers from `.bob/mcp.json`. Copy the template and point
it at your clone:

```powershell
cp .bob/mcp.json.example .bob/mcp.json
# edit the three /absolute/path/to/bob-control paths
```

Bob hot-reloads `.bob/mcp.json` on save and lists `bob-tasks` under the MCP
Servers panel's Project tab. To make it available in every workspace, put the
same `mcpServers` block in the global file instead:

```
%APPDATA%\IBM Bob\User\globalStorage\ibm.bob-code\settings\mcp_settings.json
```

## Bob Companion (Claude Code plugin)

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
#   /plugin marketplace add /absolute/path/to/bob-control
#   /plugin install bob-companion@bob-control
```

| Surface | What it does |
| ------- | ------------ |
| `/bob-new <desc>` | Turn a rough ask into one well-formed task (title, criteria, priority, tags, routed mode) |
| `/bob-board [tag]` | The board grouped by status, in pull order |
| `/bob-next [tag]` | What Bob pulls next and the mode it routes to (read-only; never claims) |
| `/bob-route <id\|text>` | Predict the dispatch mode for a task or a hypothetical |
| `/bob-triage [focus]` | Review the board, propose fixes, apply the safe ones on confirm |
| `/bob-review-diff [range]` | Queue a read-only Bob (`review`-mode) code review of the diff you just made; findings land on the board |
| `/bob-work [tag] [--max N]` | **Worker:** claim pending tasks Claude can do, execute them, submit results |
| `/bob-statusline` | Install (or `--remove`) a live one-line board summary in your Claude Code status line |
| `bob-foreman` subagent | Split a large request into several correctly-routed, ordered tasks |
| **Skills** (model-invoked) | Ask for IBM Bob by name to dispatch its specialty modes: **bob-review** (`review`), **bob-plan** (`plan`), **bob-refactor** (`refactor`), **bob-security** (`devsecops`) |

### Boards are per project

The plugin's MCP server points at **the open project's own** board —
`${CLAUDE_PROJECT_DIR}/data/tasks.db` — so every repo has its own queue. For Bob to share a
project's queue, its `.bob/mcp.json` must set the **same** `BOB_TASKS_DB` for that project;
[`tools/init-project-board.mjs <dir>`](tools/init-project-board.mjs) scaffolds a correct
per-project `.bob/mcp.json` (pointing at the shared connector's `dist/server.js`, with
`BOB_TASKS_DB`/`cwd` set, and creates `data/`). `/bob-work` claims tasks as `claude` and
leaves IBM-i/RPG work for Bob, so the two never double-work a task.

Prefer one queue across **every** repo instead? Set `BOB_TASKS_PORTABLE=1` on both the plugin
and Bob to share a fixed `~/.bob-tasks/tasks.db`. Either way the server logs the resolved
board path on startup, so you can confirm both tools agree.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `create_task` | Add a task (`staged:true` = created non-pullable, for bulk curation) |
| `list_tasks` | List tasks, filter by status/tag |
| `get_task` | One task plus its notes and any open `pending_question` |
| `get_next_task` | Highest-priority pending task; optionally claim it (null while disarmed) |
| `claim_task` | Mark in_progress and assign (only `pending`, only while armed) |
| `update_task_status` | Set status (pending / in_progress / blocked / analysis_done / done / cancelled; `staged` & `needs_input` are set by their own tools) |
| `add_task_note` | Append a progress note |
| `submit_result` | Complete a task: read-only run → `analysis_done`; implementation reaches `done` only with `evidence` |
| `set_task_mode` | Set or clear a task's mode slug |
| `set_task_dependencies` | Set/clear the task IDs this one waits on (all must be done/analysis_done); rejects cycles |
| `record_artifact` | Record a file/commit/test a worker produced (delete-safety + done-evidence) |
| `delete_task` | Delete a task; warns/refuses if it recorded artifacts unless `force`, with optional `cleanup` |
| `revert_task` | Roll the working tree back to the task's pre-task checkpoint (undo what it changed) |
| `board_report` | Markdown standup/audit of the board, grouped by status |
| `board_status` | Dispatch state: armed?, worker-active heuristic, counts by status |
| `arm_board` / `disarm_board` | Resume / pause all dispatch (curation gate) |
| `release_tasks` | Move staged tasks → pending (release after curation) |
| `ask_question` | Raise a question for a human; parks the task `needs_input` (never guess) |
| `answer_task_question` | Answer a worker's question (by `question_id`); resumes the worker |
| `await_answer` | The worker's blocking wait for an answer (poll of the shared board) |

A typical Bob loop: `get_next_task {claim:true}` then `add_task_note` while working,
then `submit_result`. If it needs a value it can't determine, `ask_question` → `await_answer`
rather than guessing.

## CLI

The CLI shares the same store:

```powershell
node dist/cli.js create "Modernize INVRPT report" --priority high --tags rpg
node dist/cli.js create "Bulk task" --staged             # non-pullable until released
node dist/cli.js list --status pending --tag rpg
node dist/cli.js show 1
node dist/cli.js claim 1 --assignee bob
node dist/cli.js status 1 blocked                        # set status (rejects staged/needs_input)
node dist/cli.js mode 1 refactor                         # set/clear the mode slug
node dist/cli.js deps 3 1,2                               # task 3 waits on 1 and 2 (empty clears)
node dist/cli.js note 1 "Waiting on test data"
node dist/cli.js result 1 "Done; 3 procedures extracted"
node dist/cli.js next                                    # next pending task + its routed mode
node dist/cli.js delete 1 [--force] [--cleanup]          # refuses if it wrote files; cleanup removes created ones
node dist/cli.js revert 1 [--force]                      # roll the tree back to task 1's checkpoint while one exists (--force if HEAD moved)
node dist/cli.js stats
node dist/cli.js report                                  # markdown standup/audit of the board
node dist/cli.js report --status blocked --out report.md

# curation gate (pause dispatch while you triage, then release)
node dist/cli.js disarm "triaging"                        # no worker pulls until armed
node dist/cli.js release --tag batch                      # staged -> pending (all, or by ids/tag)
node dist/cli.js arm                                      # resume dispatch
node dist/cli.js board                                    # armed? + counts by status

# answer a worker's question (see "Asking a human" below)
node dist/cli.js questions                                # open questions awaiting an answer
node dist/cli.js answer 5 <question_id> pool size is 20
```

`report` groups tasks by status in pull order, each with age, idle time, the
latest note, and a ⚠ stalled flag for in_progress work idle over 30 min — handy
for a standup or spotting wedged tasks. It also prints an audit summary tallying
unattended automation activity from task notes: classifier approvals/denials,
answerer answers/escalations, and human actions (with an estimated classifier
cost). Same output is available to agents via the `board_report` MCP tool.

## Modes

Each task carries a mode (or routes to one); on dispatch the connector sends it to Bob
along with a matching risk level and auto-approve profile (see [src/modes.ts](src/modes.ts)).
Eight built-in modes:

| Mode | Risk | What it's for |
| ---- | ---- | ------------- |
| `ask` | safe | Read-only — explain / research / document. No writes or commands. |
| `plan` | safe | Read-only planning/design — produces a plan, no code changes. |
| `review` | safe | Read-only code review — returns structured findings (see below). |
| `code` | standard | Normal edit + build + run. The default. |
| `refactor` | standard | Behavior-preserving restructuring/cleanup. |
| `devsecops` | standard | Security-focused remediation — finds **and fixes** vulnerabilities (write-capable; the LLM judge verifies the fix). |
| `orchestrator` | standard | Coordinate a multi-step epic with sub-tasks. |
| `advanced` | elevated | `code` plus MCP + browser power. |

Leave a task's mode blank and the keyword router picks one from the title, description, and
tags. The router only auto-routes to `ask`, `advanced`, `orchestrator`, or `code`; the
specialty modes (`plan` / `review` / `refactor` / `devsecops`) are reached by setting the mode
explicitly, a tag naming the mode, or the plugin's model-invoked skills.

```powershell
node dist/cli.js create "Explain the IPC envelope"   # routes to ask
node dist/cli.js create "Fix bug in db.ts"           # routes to code
node dist/cli.js create "Add export" --mode refactor # explicit
node dist/cli.js route 1                             # preview the routed mode
```

Precedence: explicit mode, then a tag naming a mode, then the keyword router,
then `code`.

## Worker

The worker drains the board one task at a time: pull the next eligible task
(highest priority whose dependencies are all `done`), route it, dispatch to Bob
in the sidebar, wait for the result, write it back, mark it done (verification and
retry below are opt-in).

```powershell
npm run worker              # drain, then idle-poll
node dist/worker.js --once  # one task then exit
node dist/worker.js --tag rpg
node dist/worker.js --dry-run
```

Flags: `--once` `--tag <t>` `--dry-run` `--pipe` `--poll` `--timeout` `--assignee`
`--new-tab` `--max-risk <safe|standard|elevated>` `--retry <N>` `--detect-plan-stop`
`--no-notify` `--no-defer` `--answer-followups` `--escalate-all` `--review-plans`
`--allow-commands <prefix,prefix>` `--deny-commands <prefix,prefix>` `--no-command-gate`
`--allow-all-commands` `--no-checkpoint` `--no-idle-watchdog` `--idle-timeout <ms>`
`--no-budget` `--budget-cap <tokens>` `--max-turns <n>` (plus the verify-and-continue flags below).
Needs Bob running with IPC enabled (see below).
Aborted or timed-out tasks are parked as `blocked`; with `--retry <N>` the worker first
re-dispatches a transient failure (timeout/abort) up to N times before parking it.
`--detect-plan-stop` catches a "completion" that wrote no code (Bob just presented a plan)
and continues it instead of marking it done.

The worker is resilient across Bob restarts: if the IPC pipe drops it reconnects on the next
dispatch (instead of wedging), and on startup it re-queues any task a previous run left
`in_progress` when it died mid-dispatch, so nothing is stranded.

Each mode has a risk level, and the worker only dispatches tasks at or below
`--max-risk` (default `standard`); higher-risk ones stay pending for manual
dispatch. On finish the worker pops a tray toast (`--no-notify` to silence; the
system sound and terminal bell are off by default).

### Task dependencies

A task can declare `depends_on` — other task IDs that must all be `done` before it
becomes eligible. The worker's pull queue **skips a task while any dependency is unmet**
(surfaced as *blocked on dependencies*), so you can queue an ordered pipeline and let one
drain run it end to end. Dependencies are validated when set: a missing ID is rejected, and
an edge that would form a **cycle** is refused (DFS check in [src/db.ts](src/db.ts)).

```powershell
node dist/cli.js create "Write tests for INVRPT"        # -> #5
node dist/cli.js create "Refactor INVRPT" --depends-on 5  # won't dispatch until #5 is done
node dist/cli.js deps 6 5                                # set/clear deps on an existing task (empty clears)
```

Over MCP, pass `create_task {depends_on:[…]}` or call the `set_task_dependencies` tool.

### Unattended execution

Each dispatch sends the mode's auto-approve profile — the `autoApprovalEnabled`
master switch, per-category toggles, and a curated `SAFE_COMMANDS` allowlist — so
Bob runs without stalling on approval prompts. Read-only modes (`ask`/`plan`/`review`)
take no writes; the write-capable modes (`code`/`refactor`/`devsecops`/`orchestrator`/
`advanced`) add writes; all of them auto-run allowlisted commands (build/test/vcs) and
prompt for anything else. This per-dispatch profile is enough for the worker on
its own; to apply the same auto-approve to your *interactive* Bob session, fully quit
Bob and launch via [launch-bob-ipc.cmd](launch-bob-ipc.cmd) (it runs
[set-bob-autoapprove.mjs](set-bob-autoapprove.mjs), which writes the same allowlist to
Bob's global state).

For the gray zone (a command not on the allowlist), the worker resolves the approval prompt
**non-interactively by default** — a headless dispatch never waits on a human. A deterministic
permission gate ([command-policy.ts](src/command-policy.ts)) evaluates the command: an allowlisted one
(safe local git subcommands, `pytest` / `uv run pytest` / `python -m pytest`, python, scoped
`__pycache__` cleanup) is approved; a denied or unrecognised one (`git push`, network installs,
`curl`/`wget`/`sudo`, `rm -rf` outside the repo) is rejected, recorded as a **`needs_input`** question
(the exact command + cwd + task), and the dispatch is **ended promptly** so a blocked command can't
burn the wall-clock. Tune it with `--allow-commands` / `--deny-commands` (comma-separated), or:

```powershell
node dist/worker.js --allow-commands "make build,go test"   # extend the auto-run allowlist
node dist/worker.js --no-command-gate                       # disable the gate (idle watchdog stays the backstop)
node dist/worker.js --allow-all-commands                    # SANDBOX ONLY: auto-run every command, gate off
```

For an unrecognised command the deterministic gate default-denies; to instead have **Claude** judge
the gray zone, add `--command-classifier`:

```powershell
node dist/worker.js --command-classifier                             # cli backend: reuses your Claude login, no key
node dist/worker.js --command-classifier --classifier-backend api    # one Anthropic call (needs ANTHROPIC_API_KEY)
```

The classifier presses approve/reject over IPC, which needs a one-time patch that exposes Bob's
buttons — `node tools/patch-bob-buttons.mjs`, then restart Bob. Fail-safe: only an explicit "approve"
runs a command; any error or timeout falls back to the deterministic default-deny. Extra flags:
`--classifier-backend <cli|api>` `--classifier-model` `--classifier-cli`.

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

### Resilience guards: checkpoint-before-death, idle watchdog, token budget

The worker hardens each unattended dispatch against the ways it can die without finishing. These
are **on by default** (in a git repo); tune or disable them with the flags noted.

**Checkpoint-before-death → branch.** Before each task the worker captures a **pre-task git
snapshot** (pinned, gc-safe). On **any** terminal failure — an idle / blocked-on-ask trip, a token
budget abort, a no-result timeout/abort (after retries), a verify/judge give-up, or a worker error
— it **preserves the dispatch's partial work to a dedicated `bob/task-<id>` branch and restores the
working tree to its pre-task state**, so a dying run never leaves uncommitted WIP on `main`. Recover
the stranded work with `git checkout bob/task-<id>`; the failure note records the branch and root
cause. `--no-checkpoint` disables it; no-op outside a git repo, or when the task **committed** its
work (HEAD moved — see *Verified* below).

The same machinery powers the manual `bob revert <id>` / `revert_task` rollback, which restores a
task's pre-task checkpoint **while one still exists**. The checkpoint is **consumed on completion**
(both on success and when failed work is preserved to a branch), so it never pins a commit per task
forever — which means `revert` is a no-op once a task has terminated; recover a failed task's work
from its `bob/task-<id>` branch instead.

The manual rollback is destructive, so it's **safe by construction** ([src/checkpoint.ts](src/checkpoint.ts)):
- **Repo-bound** — the checkpoint records the repo it came from; a revert run in any *other*
  working tree is **refused**, never applied to the wrong repo.
- **Pinned** — the snapshot is held by a real ref (`refs/bob/checkpoint/<id>`), so `git gc`
  can't reclaim it before you revert.
- **Verified** — if the snapshot is missing, or **HEAD moved** since capture (a commit landed),
  the revert refuses rather than silently half-restoring or orphaning a commit (`--force` /
  `force:true` overrides the HEAD-moved check).
- **Recoverable** — the pre-revert state is pinned to a `refs/bob/recovery/<sha>` ref first, so
  discarded work is never truly lost (the command prints the ref).
- **HEAD-preserving** — tracked files are restored with `git read-tree` (HEAD/branch untouched);
  only files the task *created* are removed (emptied dirs pruned). Pre-task edits and
  pre-existing untracked files are left intact.

No-op outside a git repo. Gitignored files a task creates aren't auto-removed (they're not the
tracked snapshot's concern). Deleting a task also drops its checkpoint ref; `refs/bob/recovery/<sha>`
refs from past reverts are kept as a safety net and can be pruned by hand once you're sure you don't
need them.

**Idle / blocked-on-ask watchdog.** A dispatch that makes no progress for `--idle-timeout` (180s
default) — or wedges on a prompt the headless worker can't answer (e.g. a command-permission ask) —
ends as `idle` well before the wall clock, after a short `--blocked-ask-grace` (10s). The pending ask
is surfaced to the board as a `needs_input` question rather than swallowed. `--no-idle-watchdog`
disables it (wall-clock `--timeout` only).

**Token / turn budget.** Each task carries an estimated token scope (set at creation — see
*right-sizing*); the worker enforces `estimate × (1 + --budget-headroom%)` (floored), or a flat
`--budget-cap` when there's no estimate, as a hard ceiling that aborts a runaway loop as `budget`.
`--max-turns` adds an api-request cap; `--no-budget` disables both. (Best-effort: it reads Bob's
api-request token usage, and falls open — never trips — if that usage isn't reported.)

**Right-sizing at creation.** `create_task` estimates a task's single-dispatch scope from its
description length, the files it names, and its mode ([scope.ts](src/scope.ts)) and stamps the
`estimated_tokens` the budget ceiling above is derived from. An oversized task is tagged `too-big`,
and an oversized *implementation* task with no explicit mode is routed to `orchestrator` — which
decomposes it into subtasks — rather than dispatched doomed to a mid-work timeout.

### Review-mode findings

When a `review` task finishes, the worker captures Bob's findings to the board. Bob's
native review writes structured issues (severity, location, category, often a suggested
`fixed_diff`); under headless dispatch it's tool-restricted and returns the review as
completion text instead, so the worker parses that text back into structured findings
([src/review-findings.ts](src/review-findings.ts)). Either way the findings land as the task
`result` plus a `bob-review` note — the board, not Bob's webview panel, is the source of
truth. Queue one with `/bob-review-diff` (or the `bob-review` skill / `--mode review`).

### Templates

`create --template <name>` applies a preset mode, priority, tags, and
description scaffold:

```powershell
node dist/cli.js templates
node dist/cli.js create "INVRPT report" --template bug-fix
```

Built-ins: `bug-fix`, `feature`, `research`, `code-review`, `doc`, `refactor`.

## Board safety gates

Guardrails for running unattended at scale — so a bulk-create can't race a live worker, and
"done" means something:

- **Staging / arming.** Create tasks `staged` (non-pullable) and `release_tasks` them once
  you've reviewed the set, or `disarm_board` to pause *all* dispatch while you curate, then
  `arm_board`. A worker never pulls a staged task or pulls while disarmed (enforced in the
  board layer, so both the worker and `/bob-work` obey it).
- **Done-integrity.** A read-only run (`ask`/`plan`/`review`) terminates as **`analysis_done`**,
  not `done`. An implementation task reaches `done` only with **execution evidence** (files
  changed / commit / test); without it the worker parks it `analysis_done` rather than show
  green for unbuilt work. `submit_result` takes an `evidence` field; the worker derives it from
  the task's git diff.
- **Delete-safety.** Workers record the files/commits they produce as task **artifacts**, so
  `delete_task` warns and refuses when a task already wrote files (unless `force`); `cleanup`
  removes only files the task *created* — never source it merely edited.

## Asking a human (board round-trip)

When a worker needs a value it can't determine, it **asks on the board and waits** — it does
not guess. `ask_question` parks the task **`needs_input`** and writes the question (with
optional multiple-choice `options`) where any board client can see it: `get_task` returns a
`pending_question`, and `board_report` lists an **"❓ Awaiting answer"** group with how long
it's been waiting. The worker then blocks on `await_answer` (a poll of the shared board).

Anyone answers with one call — `answer_task_question(task_id, question_id, answer)` over MCP, or
`bob answer <id> <question_id> <text>` from a terminal — and the waiting worker resumes. Answers
are matched by a unique `question_id`, so a stale answer can't apply to a new question. Fail-safe:
a question unanswered past its deadline times out and the task parks `blocked` (a board-activity
sweep fires this even if the asking worker died) — never a fabricated answer, never a silent
`done`. The `bob-work` skill follows this path instead of inventing a value.

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

`id`, `title`, `description`, `status`, `priority` (low/medium/high/urgent), `tags[]`,
`mode` (or null to auto-route), `depends_on[]` (task IDs that must be `done`/`analysis_done`
first), `assignee`, `result`, timestamps, plus per-task **notes**, **artifacts**
(files/commits/tests a worker produced), and **questions** (the ask/answer round-trip) tables.

Status lifecycle: `staged` (created non-pullable) → `pending` → `in_progress` →
`needs_input` (awaiting a human answer) → back to `in_progress`, or a terminal
`analysis_done` (read-only / no verified code) · `done` · `blocked` · `cancelled`.

## Development

```powershell
npm run build         # tsc -> dist/ + the plugin bundle
npm test              # node:test suite (board logic, gates, parsers, checkpoint, …)
npm run lint          # ESLint 9 (flat config, typescript-eslint)
npm run format        # Prettier --write   (format:check to verify)
```

CI (GitHub Actions, `windows-latest`, Node 22 + 24) runs lint → format-check → build →
test-with-coverage on every push/PR; a red check blocks merge. Before opening a PR, run
`npm run lint && npm run format:check && npm test`.

## Layout

```
src/
  types.ts        task types and enums
  db.ts           SQLite store + repository (connection, tasks, deps, artifacts, checkpoints)
  questions.ts    board-native ask/answer/timeout round-trip (extracted from db.ts)
  completion.ts   done-integrity gate: completeTask + Evidence (extracted from db.ts)
  modes.ts        mode slugs, router, per-mode risk + auto-approve profiles
  templates.ts    task templates
  bob-ipc.ts      async IPC client (BobClient; approve/reject/sendMessage)
  bob-polls.ts    verify-and-continue poll loop (re-dispatch until it passes)
  llm.ts          shared Claude transport (api / cli backends)
  classify.ts     command-safety classifier (gray-zone command asks) + hard deny-list
  json-extract.ts balanced-brace JSON extraction shared by classify/answer/judge
  command-policy.ts deterministic command allow/deny/escalate policy (allowlist source + gate resolver)
  permission-gate.ts default-on non-interactive permission gate (allow->approve, deny->needs_input + end)
  command-gate.ts gray-zone LLM approve/reject gate (worker -> IPC), the escalation path
  answer.ts       answerer for Bob's followup questions
  followup-gate.ts answer-or-escalate gate for followup asks (worker -> IPC)
  worker-answer.ts handle a human's answer to an escalated followup
  judge.ts        LLM acceptance judge + scoped git-diff capture (verify-and-continue)
  verdict-cache.ts LRU cache for classifier verdicts (skip repeat calls for identical commands)
  review-findings.ts (de)serialize review-mode findings (text <-> structured) for the board
  retry-policy.ts retry/backoff for failed dispatches
  watchdog.ts     idle / blocked-on-ask dispatch watchdog (ends a wedged run early)
  budget.ts       per-dispatch token/turn budget tracker + ceiling
  scope.ts        task scope estimate for right-sizing at creation
  checkpoint.ts   per-task git checkpoint: capture, preserve-to-branch on death, revert
  defer.ts        pause dispatch while you're chatting with Bob
  report.ts       board -> markdown standup/audit (CLI + board_report tool)
  notify.ts       desktop toast and terminal bell
  server.ts       MCP server (stdio)
  cli.ts          CLI
  worker.ts       auto-dispatch loop
  smoke.ts        self-test
tools/
  patch-bob-buttons.mjs   expose Bob's approve/reject buttons + GetReviewFindings over IPC
```
