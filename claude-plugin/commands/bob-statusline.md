---
description: Install (or update) the live Bob board status line in your Claude Code settings
argument-hint: "[optional: --remove to uninstall]"
allowed-tools: Read, Write, Edit
---

Wire the Bob task-board status line into the user's Claude Code settings so every
session shows a live `⚡ Bob: N running · #id title` summary alongside the model and
directory.

The status-line script ships with this plugin at:

    ${CLAUDE_PLUGIN_ROOT}/bin/statusline-bob.mjs

It tracks the **current session's project board** (`<project>/data/tasks.db`) — the same
board this plugin's MCP server uses (`${CLAUDE_PROJECT_DIR}/data/tasks.db`) — so each
open project shows only its own queue. If a project has no board yet, it falls back to
the shared portable board (`~/.bob-tasks/tasks.db`).

Do this:

1. Determine the absolute path to the script above (expand `${CLAUDE_PLUGIN_ROOT}`).

2. Read the user settings file `~/.claude/settings.json`
   (Windows: `%USERPROFILE%\.claude\settings.json`). If it doesn't exist, start from `{}`.
   Parse it as JSON, preserving every existing key.

3. **If `$ARGUMENTS` contains `--remove`:** delete the `statusLine` key (if present) and
   write the file back. Confirm removal and stop.

4. Otherwise set the `statusLine` key to:

   ```json
   {
     "type": "command",
     "command": "node \"<ABS_SCRIPT_PATH>\""
   }
   ```

   where `<ABS_SCRIPT_PATH>` is the resolved absolute path from step 1. On Windows,
   JSON-escape the backslashes in the path (each `\` becomes `\\`). Do **not** append a
   board-path argument — omitting it lets the script resolve the current project's board
   per session (and fall back to the shared portable board when a project has none).

   If a `statusLine` key already exists, replace it (tell the user you overwrote the
   previous one, and what it was).

5. Write the merged JSON back to `~/.claude/settings.json` with 2-space indentation, then
   verify it still parses as valid JSON.

6. Confirm what you wrote and remind the user to **reload Claude Code** (or start a new
   session) for the status line to take effect. Mention they can run
   `/bob-statusline --remove` to undo it, and that the line stays quiet (model · dir only)
   whenever no Bob tasks are running or queued.

Keep it to a short confirmation — this is a one-time setup action, not an essay.
