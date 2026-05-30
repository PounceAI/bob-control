# Bob Tasks Extension

Auto-dispatch queued board tasks to IBM Bob with mode auto-routing, a risk gate, defer-while-chatting, and native notifications.

## What It Does

The Bob Tasks extension runs the project's `dist/worker.js` to automatically claim and dispatch queued tasks from the task board to IBM Bob. It:

- **Auto-routes tasks** to the appropriate Bob mode (`code`, `advanced`, `ask`, `orchestrator`) based on task content/metadata
- **Enforces a risk gate** — only dispatches tasks whose mode risk is at or below your configured threshold
- **Defers while chatting** — pauses auto-dispatch when you're actively using Bob's chat, so the worker never aborts your live conversation
- **Shows native notifications** — in-IDE toasts when tasks complete or fail
- **Provides worker controls** — Start/Stop/Toggle commands and a status-bar item showing worker state

## Settings

All settings are under the `bobTasks.*` namespace:

- **`bobTasks.projectRoot`** — Path to the IBM Bob Connector project (containing `dist/worker.js`). Empty = the first workspace folder.
- **`bobTasks.nodePath`** — Node executable used to run the worker. Must be Node >= 22.5 (for `node:sqlite`). Set an absolute path if `node` on PATH is older.
- **`bobTasks.dbPath`** — SQLite task DB (`BOB_TASKS_DB`). Empty = the project's `data/tasks.db`. Must match the MCP server's DB.
- **`bobTasks.pipe`** — Bob IPC named pipe. Default: `\\\\.\\pipe\\pipe\\bob-ipc`.
- **`bobTasks.maxRisk`** — Only auto-dispatch tasks whose mode risk is at or below this. Options: `safe`, `standard`, `elevated`. Default: `standard`. (`advanced` mode is elevated.)
- **`bobTasks.pollMs`** — Idle poll interval (ms). Default: `3000`.
- **`bobTasks.timeoutMs`** — Per-task dispatch timeout (ms). Default: `300000` (5 minutes).
- **`bobTasks.assignee`** — Assignee recorded when the worker claims a task. Default: `bob`.
- **`bobTasks.autoStart`** — Start the worker automatically when Bob launches. Default: `false`.
- **`bobTasks.notify.enabled`** — Show a notification when a task finishes. Default: `true`.
- **`bobTasks.dispatch.surface`** — Where dispatched tasks render. `sidebar` = quiet same-tab in the IBM BOB chat; `newTab` = isolated editor tab (steals focus). Default: `sidebar`.
- **`bobTasks.dispatch.bringToFront`** — On each dispatch, bring the IBM BOB view to the front (opt-in re-focus). Off = quiet, no window jump. Default: `false`.
- **`bobTasks.deferWhileChatting`** — Pause auto-dispatch while you are actively chatting with Bob, so the worker never aborts your live chat. Resumes when the chat goes idle. Default: `true`.
- **`bobTasks.deferIdleMs`** — How long Bob's chat must be idle (ms) before the worker resumes dispatching. Default: `60000` (1 minute).

## Commands

Access via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Bob Tasks: Start Worker** — Start the task worker
- **Bob Tasks: Stop Worker** — Stop the task worker
- **Bob Tasks: Toggle Worker** — Toggle the worker on/off

## Status Bar

When the extension is active, a status-bar item shows the worker state:

- `$(sync~spin) Bob worker: running` — worker is active
- `$(debug-pause) Bob worker: deferred (chat active)` — worker is paused because you're chatting with Bob
- `$(circle-slash) Bob worker: stopped` — worker is not running

Click the status-bar item to toggle the worker.

## Build & Install

### Prerequisites

1. **IBM Bob Connector built** — The parent project must be built at `../dist` (relative to this extension directory). Run `npm install && npm run build` in the project root.
2. **Bob launched with IPC** — Bob must be running with `ROO_CODE_IPC_SOCKET_PATH` set to the named pipe (e.g., `\\\\.\\pipe\\pipe\\bob-ipc` on Windows). Use the project's `launch-bob-ipc.cmd` script.
3. **Node >= 22.5** — The worker requires Node 22.5 or later for `node:sqlite`. Verify with `node --version`. If your system Node is older, set `bobTasks.nodePath` to an absolute path to a newer Node binary.

### Build Steps

```bash
cd extension
npm install
npm run build
```

This compiles the TypeScript source to `extension/out/extension.js`.

### Install into Bob

**Option 1: Install from VSIX (recommended)**

```bash
npm run package
```

This creates `bob-tasks-0.1.0.vsix`. Then in Bob:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **Extensions: Install from VSIX…**
3. Select the `.vsix` file
4. Reload Bob

**Option 2: Manual install**

Copy the entire `extension/` directory to Bob's extensions folder:

- Windows: `%USERPROFILE%\.bobide\extensions\local.bob-tasks-0.1.0\`
- macOS/Linux: `~/.bobide/extensions/local.bob-tasks-0.1.0/`

Then reload Bob.

## Usage

1. Configure settings (especially `bobTasks.projectRoot` if the extension isn't in the connector project)
2. Run **Bob Tasks: Start Worker** from the Command Palette
3. The worker will poll for queued tasks and auto-dispatch them to Bob
4. Watch the status bar for worker state
5. Receive native notifications when tasks complete

The worker respects your `bobTasks.maxRisk` setting and will defer while you're actively chatting with Bob (if `bobTasks.deferWhileChatting` is enabled).