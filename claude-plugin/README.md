# Bob Foreman — Claude Code plugin

Use Claude Code, **from any repo**, as the foreman and worker for the
[IBM Bob Task Connector](../README.md) board: describe work in plain language and Claude
provisions, routes, and triages tasks — or claims and *executes* them itself. Bob and
Claude share one queue.

The plugin is self-contained: it ships a bundled MCP server (`server/server.mjs`, the
connector compiled to one file via esbuild), so installing the plugin is all you need —
no connector checkout at runtime. The bundle has zero native dependencies because the
connector is plain TypeScript on the built-in `node:sqlite`.

## What's in it

- **MCP server** (`.mcp.json` → `server/server.mjs`) — the 10 task tools, with
  `BOB_TASKS_PORTABLE=1` so the board lives at a shared `~/.bob-tasks/tasks.db`
  (Windows: `%USERPROFILE%\.bob-tasks\tasks.db`) that every repo and Bob agree on.
- **Foreman commands**
  - `/bob-new <rough description>` — turn a rough ask into one well-formed task.
  - `/bob-board [tag]` — the board grouped by status, in pull order.
  - `/bob-next [tag]` — what Bob pulls next and the mode it routes to (read-only).
  - `/bob-route <id | text>` — predict the dispatch mode for a task or a hypothetical.
  - `/bob-triage [focus]` — review the board, propose fixes, apply the safe ones on confirm.
- **Worker command**
  - `/bob-work [tag] [--max N] [--one] [--dry-run]` — claim pending tasks Claude can do in
    the current repo, execute them, log progress, and submit results. Claims as `claude`
    so it never collides with Bob (who only pulls `pending`); leaves IBM-i/RPG work for Bob;
    respects each task's mode (an `ask` task stays read-only); parks anything it can't finish
    as `blocked`.
- **Subagent** `bob-foreman` — split a large request into several correctly-routed, ordered tasks.
- **Status line** (`bin/statusline-bob.mjs`) — a live one-line board summary
  (`⚡ Bob: N running (M queued) · #id title …`) shown next to the model and directory.
  Run `/bob-statusline` once to install it (Claude Code doesn't let plugins set a status
  line directly, so this command writes the snippet into your `~/.claude/settings.json`
  for you, pointing at the shared portable board). `/bob-statusline --remove` undoes it.
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
/plugin marketplace add /absolute/path/to/ibm-bob-connector
/plugin install bob-foreman@ibm-bob-connector
```

Reload when prompted, approve the `bob-tasks` server, and the commands are available in
**every** repo you open. Optionally run `/bob-statusline` once to add the live board
status line to your settings.

## Share the board with Bob

Point Bob at the same central board by setting the same flag in its `.bob/mcp.json`:

```jsonc
"env": { "BOB_TASKS_PORTABLE": "1" }
```

Both sides then resolve `~/.bob-tasks/tasks.db`. The server logs the resolved path on
startup (`board: …`) if you want to confirm or back it up. To migrate an existing
repo-local board, copy `data/tasks.db` (plus `-wal`/`-shm`) into `~/.bob-tasks/`.

Requires Node ≥ 22.5 on PATH (built-in `node:sqlite`).
