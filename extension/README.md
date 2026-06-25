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

- **`bobTasks.connectorPath`** — Absolute path to the Bob Control connector install (the folder containing `dist/worker.js`). Set it once (User scope) so the worker can start regardless of which project Bob has open. Empty = auto-detect: any open workspace folder that contains `dist/worker.js`, else the legacy `bobTasks.projectRoot` if it still points at the install.
- **`bobTasks.projectRoot`** — Working directory the worker runs in — the project Bob operates on (verify/judge run git here). Empty = the first workspace folder. To locate `dist/worker.js`, use `bobTasks.connectorPath` instead.
- **`bobTasks.nodePath`** — Node executable used to run the worker. Must be Node >= 22.5 (for `node:sqlite`). Set an absolute path if `node` on PATH is older.
- **`bobTasks.dbPath`** — SQLite task DB (`BOB_TASKS_DB`). Empty = the project's `data/tasks.db`. Must match the MCP server's DB.
- **`bobTasks.worktreeShared`** — Share ONE board across all linked git worktrees of a repo: this worktree's worker drains the **main** worktree's `data/tasks.db`. Governs the worker only — to also make a Claude session running *inside* a linked worktree file to the shared board, set `BOB_TASKS_WORKTREE_SHARED=1` in the environment (every consumer reads it). Ignored when `bobTasks.dbPath` is set; a no-op for non-worktree projects.
- **`bobTasks.pipe`** — Bob IPC named pipe. Blank = auto-detect this instance's own pipe from `ROO_CODE_IPC_SOCKET_PATH` (needed when multiple Bob instances run at once); set only to override. Fallback: `\\.\pipe\pipe\bob-ipc`.
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
- **`bobTasks.verifyCommand`** — Command to run for acceptance checks when `verifyAndContinue` is on. Empty = the check blind-passes (no verify command — not checked); enable `bobTasks.verifyJudge` for a real gate. Exit code 0 = pass, non-zero = fail.
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

1. **Bob Control built** — The parent project must be built at `../dist` (relative to this extension directory). Run `npm install && npm run build` in the project root.
2. **Bob launched with IPC** — Bob must be running with `ROO_CODE_IPC_SOCKET_PATH` set to `\\.\pipe\bob-ipc`. Use the project's `launch-bob-ipc.cmd` script. (node-ipc internally mangles that into a doubled `\\.\pipe\pipe\bob-ipc` — the name the worker actually connects to, and the default of `bobTasks.pipe`.) Launching Bob any other way (Start menu, taskbar) skips both the IPC pipe **and** `set-bob-autoapprove.mjs`, so the worker can't connect and commands stall on manual prompts. Start the worker without `ROO_CODE_IPC_SOCKET_PATH` set and the extension warns with *How to fix* / *Start anyway* rather than spawning a doomed worker. Repoint your Start/taskbar shortcut at `launch-bob-ipc.cmd` so it can't be bypassed.
3. **Node >= 22.5** — The worker requires Node 22.5 or later for `node:sqlite`. Verify with `node --version`. If your system Node is older, set `bobTasks.nodePath` to an absolute path to a newer Node binary.

### Build Steps

```bash
cd extension
npm install
npm run build
```

This compiles the TypeScript source to `extension/out/extension.js`.

### Install into Bob

**Option 1: Download the released VSIX (recommended)**

Download the latest `bob-tasks-*.vsix` from the [Releases page](https://github.com/PounceAI/bob-control/releases). Then in Bob:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **Extensions: Install from VSIX…**
3. Select the `.vsix` file
4. Reload Bob

**Option 2: Build the VSIX yourself**

```bash
npm run package
```

This creates `bob-tasks-<version>.vsix`; install it as in Option 1.

**Option 3: Manual install**

Copy the entire `extension/` directory to Bob's extensions folder:

- Windows: `%USERPROFILE%\.bobide\extensions\local.bob-tasks-<version>\`
- macOS/Linux: `~/.bobide/extensions/local.bob-tasks-<version>/`

Then reload Bob.

## Usage

1. Configure settings (especially `bobTasks.connectorPath` if the connector isn't an open workspace folder)
2. Run **Bob Tasks: Start Worker** from the Command Palette
3. The worker will poll for queued tasks and auto-dispatch them to Bob
4. Watch the status bar for worker state
5. Receive native notifications when tasks complete

The worker respects your `bobTasks.maxRisk` setting and will defer while you're actively chatting with Bob (if `bobTasks.deferWhileChatting` is enabled).