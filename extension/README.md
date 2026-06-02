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

### Core Settings

- **`bobTasks.projectRoot`** — Path to the IBM Bob Connector project (containing `dist/worker.js`). Empty = the first workspace folder.
- **`bobTasks.nodePath`** — Node executable used to run the worker. Must be Node >= 22.5 (for `node:sqlite`). Set an absolute path if `node` on PATH is older.
- **`bobTasks.dbPath`** — SQLite task DB (`BOB_TASKS_DB`). Empty = the project's `data/tasks.db`. Must match the MCP server's DB.
- **`bobTasks.pipe`** — Bob IPC named pipe. Default: `\\\\.\\pipe\\pipe\\bob-ipc`.
- **`bobTasks.maxRisk`** — Only auto-dispatch tasks whose mode risk is at or below this. Options: `safe`, `standard`, `elevated`. Default: `standard`. (`advanced` mode is elevated.)
- **`bobTasks.pollMs`** — Idle poll interval (ms). Default: `3000`.
- **`bobTasks.timeoutMs`** — Per-task dispatch timeout (ms). Default: `300000` (5 minutes).
- **`bobTasks.assignee`** — Assignee recorded when the worker claims a task. Default: `bob`.
- **`bobTasks.tag`** — Only process tasks with this tag. Empty = all tasks.
- **`bobTasks.autoStart`** — Start the worker automatically when Bob launches. Default: `false`.

### UI Settings

- **`bobTasks.notify.enabled`** — Show a notification when a task finishes. Default: `true`.
- **`bobTasks.dispatch.surface`** — Where dispatched tasks render. `sidebar` = quiet same-tab in the IBM BOB chat; `newTab` = isolated editor tab (steals focus). Default: `sidebar`.
- **`bobTasks.dispatch.bringToFront`** — On each dispatch, bring the IBM BOB view to the front (opt-in re-focus). Off = quiet, no window jump. Default: `false`.

### Defer-While-Chatting

- **`bobTasks.deferWhileChatting`** — Pause auto-dispatch while you are actively chatting with Bob, so the worker never aborts your live chat. Resumes when the chat goes idle. Default: `true`.
- **`bobTasks.deferIdleMs`** — How long Bob's chat must be idle (ms) before the worker resumes dispatching. Default: `60000` (1 minute).

### Command Classifier & Followup Answerer

- **`bobTasks.commandClassifier`** — Let Claude approve/deny commands that fall outside the safe allowlist (instead of Bob's manual prompt) for code, orchestrator, and advanced modes. Requires the Bob button patch (`tools/patch-bob-buttons.mjs`). Default: `false`.
- **`bobTasks.answerFollowups`** — Let Claude answer Bob's followup questions during a task (sending the reply over IPC), escalating to you when it's unsure. Off = questions wait for you. Default: `false`.
- **`bobTasks.escalateAll`** — Escalate ALL followup questions to you for review (including plan approvals), instead of auto-answering. Only applies when `answerFollowups` is on. Default: `false`.
- **`bobTasks.reviewPlans`** — Escalate plan/design-approval questions to you for review, while auto-answering mechanical clarifications (file paths, flag names, etc.). Only applies when `answerFollowups` is on. Takes precedence over `escalateAll` when both are on. Default: `false`.
- **`bobTasks.classifierBackend`** — How the command classifier reaches Claude. Options: `cli` (run the installed `claude` CLI headless), `api` (one raw Anthropic API call). Default: `cli`.
- **`bobTasks.classifierModel`** — Model the command classifier uses. Empty = per-backend default (`cli`→`claude-sonnet-4-6`, `api`→`claude-haiku-4-5`).
- **`bobTasks.classifierCliPath`** — Path to the `claude` executable for the cli backend. Empty = resolve `claude` on PATH.

### Verify-and-Continue

- **`bobTasks.verifyAndContinue`** — After Bob completes a task, run an acceptance check and loop back to Bob to fix issues until it passes or `maxContinues` is reached. Catches broken builds/tests without human intervention. Default: `false`.
- **`bobTasks.verifyCommand`** — Command to run for acceptance checks when `verifyAndContinue` is on. Empty = use built-in heuristics (git working-tree check). Exit code 0 = pass, non-zero = fail.
- **`bobTasks.verifyJudge`** — Use an LLM judge to verify task completion when no `verifyCommand` is set. The judge reviews Bob's work against the task criteria and actual code changes (git diff). Uses the same backend as the command classifier. When both `verifyCommand` and `verifyJudge` are on, the command runs first and the judge provides an additional gate. Default: `false`.
- **`bobTasks.maxContinues`** — Maximum number of fix loops when `verifyAndContinue` is on. After this many attempts, the task is marked as failed. Default: `3`.
- **`bobTasks.detectPlanStop`** — Check if Bob did real work (git working-tree changed) after completion. If the tree is clean (plan-only, no code written), auto-continue asking Bob to implement the plan. Default: `false`.

### Retry & Command Allowlist

- **`bobTasks.maxRetryAttempts`** — Auto-retry transient failures (timeout/abort) up to this many total attempts. `0` = no retries. Default: `0`.
- **`bobTasks.allowCommands`** — Comma-separated command prefixes to extend the safe allowlist for advanced mode (e.g., `git,npm test`). Empty = use built-in allowlist only.

## Commands

Access via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Bob Tasks: Start Worker** — Start the task worker
- **Bob Tasks: Stop Worker** — Stop the task worker
- **Bob Tasks: Toggle Worker** — Toggle the worker on/off

## External trigger (URI handler)

The extension registers a URL handler so a process **outside** Bob — e.g. Claude Code
running in WSL — can drive the worker without a Command Palette click. The editor's URL
protocol routes the URI to the extension; the path selects the action:

| URI | Action |
| --- | --- |
| `vscode://local.bob-tasks/start` | Start the worker |
| `vscode://local.bob-tasks/stop` | Stop the worker |
| `vscode://local.bob-tasks/toggle` | Toggle the worker |

The authority is `<publisher>.<name>` = `local.bob-tasks`. Use the scheme your editor
registers — for **IBM Bob** that is `ibm-bob://` (its `product.json` `urlProtocol`); stock
VS Code uses `vscode://`. Trigger it from WSL by letting Windows dispatch the URL to the
registered handler (the URL has no spaces, so quoting is trivial):

```bash
cmd.exe /c start "" "ibm-bob://local.bob-tasks/start"
```

> Note: the `code` CLI on a WSL PATH points at **stock VS Code** (the Remote-WSL server, or
> the Windows `code.cmd`), which is a *different editor* than IBM Bob — don't use it to drive
> or install this extension. IBM Bob's own CLI is `bobide` (`bobide --open-url "…"`).

This makes the extension the **single owner** of the worker, so its status bar reflects
every dispatch and there's no two-worker contention on Bob's IPC pipe. Enqueue tasks as
usual (`./bob create …`); the extension's worker drains them.

## Status Bar

When the extension is active, a status-bar item shows the worker state (click it to toggle):

- `$(rocket) Bob Tasks: running` — worker is running (appends `#<id> {<mode>}` while a task dispatches)
- `$(watch) Bob Tasks: idle` — worker is up but the board has no eligible task (`(N gated)` if some exceed the risk gate)
- `$(debug-pause) Bob Tasks: deferred (chat active)` — paused because you're chatting with Bob
- `$(circle-slash) Bob Tasks: stopped` — worker is not running

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