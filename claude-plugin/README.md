# Bob Companion (Claude Code plugin)

Use Claude Code, **from any repo**, as the foreman and worker for the
[Bob Control](../README.md) board: describe work in plain language and Claude
provisions, routes, and triages tasks — or claims and *executes* them itself. Bob and
Claude share one queue.

The plugin is self-contained: it ships a bundled MCP server (`server/server.mjs`, the
connector compiled to one file via esbuild), so installing the plugin is all you need —
no connector checkout at runtime. The bundle has zero native dependencies because the
connector is plain TypeScript on the built-in `node:sqlite`.

## What's in it

- **MCP server** (`.mcp.json` → `server/server.mjs`) — the board's task tools, with
  `BOB_TASKS_DB=${CLAUDE_PROJECT_DIR}/data/tasks.db` so **each project you open gets its
  own board** (the per-project model the root README describes).
- **Foreman commands**
  - `/bob-new <rough description>` — turn a rough ask into one well-formed task.
  - `/bob-board [tag]` — the board grouped by status, in pull order.
  - `/bob-next [tag]` — what Bob pulls next and the mode it routes to (read-only).
  - `/bob-route <id | text>` — predict the dispatch mode for a task or a hypothetical.
  - `/bob-triage [focus]` — review the board, propose fixes, apply the safe ones on confirm.
  - `/bob-review-diff [focus | git-range]` — queue a read-only (`ask`-mode) Bob code review of the
    diff you just made (defaults to the uncommitted working-tree changes); Bob returns a
    prioritized, correctness-first findings list when its worker drains the task.
- **Worker command**
  - `/bob-work [tag] [--max N] [--one] [--dry-run]` — claim pending tasks Claude can do in
    the current repo, execute them, log progress, and submit results. Claims as `claude`
    so it never collides with Bob (who only pulls `pending`); leaves IBM-i/RPG work for Bob;
    respects each task's mode (an `ask` task stays read-only); parks anything it can't finish
    as `blocked`.
- **Specialty-mode skills** (model-invoked — Claude triggers them when you ask for IBM Bob by
  name; they auto-load from `skills/`). Each checks for duplicates, files the task in the right
  Bob mode, reports the id + routed mode, and surfaces the result via `get_task`:
  - **bob-review** (`review`) — "have Bob review this diff"; returns a correctness-first findings
    list (severity / location / `fixed_diff`) on the board. Mirrors `/bob-review-diff`.
  - **bob-plan** (`plan`) — "ask Bob to plan/design X"; read-only, returns a plan, no code changes.
  - **bob-refactor** (`refactor`) — "have Bob refactor/restructure Y"; behavior-preserving edits.
  - **bob-security** (`devsecops`) — "ask Bob for a security review/scan"; vuln-focused findings.

  These cover Bob's **specialty** modes; generic execution (`code`/`advanced`/`ask`/
  `orchestrator`) stays with `/bob-new` + the auto-router.
- **Subagent** `bob-foreman` — split a large request into several correctly-routed, ordered tasks.
- **Status line** (`bin/statusline-bob.mjs`) — a live one-line board summary
  (`⚡ Bob: N running (M queued) · #id title …`) shown next to the model and directory.
  Run `/bob-statusline` once to install it (Claude Code doesn't let plugins set a status
  line directly, so this command writes the snippet into your `~/.claude/settings.json`
  for you; the line resolves the open project's own board). `/bob-statusline --remove` undoes it.
  The line stays quiet (model · dir only) whenever nothing is running or queued.

The commands mirror the dispatcher's mode-routing rules (`src/modes.ts`), so the mode
Claude predicts is the mode Bob gets.

## Install

Build once so the bundle exists, then add the marketplace and install:

```powershell
npm install && npm run build      # produces claude-plugin/server/server.mjs
```

In Claude Code (from anywhere):

```
/plugin marketplace add /absolute/path/to/bob-control
/plugin install bob-companion@bob-control
```

Reload when prompted, approve the `bob-tasks` server, and the commands are available in
**every** repo you open. Optionally run `/bob-statusline` once to add the live board
status line to your settings.

## Share the board with Bob

Boards are per project, so Bob must open the **same** `<project>/data/tasks.db` the plugin
does. Bob doesn't expand `${CLAUDE_PROJECT_DIR}`, so each project needs its own
`.bob/mcp.json` with the path spelled out — from the connector checkout, run:

```powershell
node tools/init-project-board.mjs <project-dir>
```

It writes a correct `.bob/mcp.json` (server path, `BOB_TASKS_DB`, `cwd`), creates
`data/`, and drops in `.bob/custom_modes.yaml` defining the `review` / `refactor` /
`devsecops` modes the router targets (not Bob built-ins, so without the file those
dispatches fall back to Bob's default mode). The server logs the resolved path on
startup (`board: …`) if you want to confirm both sides agree.

Prefer one queue across **every** repo instead? Set `BOB_TASKS_PORTABLE=1` on **both**
sides (the plugin's `.mcp.json` env and Bob's) so both resolve a shared
`~/.bob-tasks/tasks.db`.

Requires Node ≥ 22.5 on PATH (built-in `node:sqlite`).
