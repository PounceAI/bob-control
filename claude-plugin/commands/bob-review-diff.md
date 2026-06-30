---
description: Send the diff you just made to Bob for a read-only code review (Bob's native review mode)
argument-hint: "[optional: a focus note, or a git ref range like main...HEAD]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task, mcp__bob-tasks__board_status
---

You are the **foreman**. The user wants **Bob** to code-review the changes that were just
made in this repo (typically the ones *you* made this session). Bob reviews in its read-only
`review` mode — it never edits; it returns a structured findings list. Under headless dispatch the
worker parses those findings onto the **board** (the task `result` plus a `bob-review` note), so
they come back to you — you don't need Bob's webview panel.

Optional argument (focus note, or an explicit git ref range):

> $ARGUMENTS

Do this:

1. **Scope the review — let Bob gather the diff itself.** Bob's `review` mode has the `read` +
   `command` groups and is told to run `git diff` / `git log` itself, so **don't embed a big
   diff** — hand Bob a *scope* and let it pull the diff.
   - If `$ARGUMENTS` has a ref range (`..`, e.g. `main...HEAD`), review `git diff <range>`.
   - Otherwise review the **uncommitted changes** (the ones just made): from
     `git status --porcelain`, name the paths in scope — exclude unrelated in-progress work —
     and review them via `git diff HEAD -- <files>` (untracked files by path).
   - If there are none, fall back to branch vs base: `git diff @{upstream}...HEAD`, or
     `git diff main...HEAD` with no upstream.
   - **Only embed** when there's no git scope to point at (a diff pasted into `$ARGUMENTS`, or
     not a repo): a fenced ```diff block, bounded to ~12,000 chars (note any truncation).
   - If there is genuinely **nothing to review**, say so and stop — don't create an empty task.

2. **File the review task** with `create_task`:
   - **mode**: `review` — Bob's **native code-review mode**. It runs read-only and returns
     structured findings (severity / location / category, many with a suggested `fixed_diff`);
     the worker writes them to the **board** (task `result` + a `bob-review` note), not Bob's
     webview panel.
   - **title**: `Code review: <short summary of the change>` (imperative, specific).
   - **tags**: `['review']` (the dedup key). If `board_status.worker_draining` shows a tag-pinned
     drainer serving this checkout, **add its pin tag too** — a worker only pulls tasks whose tags
     include its pin, so a `review`-only task sits `pending` under one. Don't pad with tags it
     won't match (`code-review`, etc.).
   - **priority**: `high` if the user signals urgency, else `medium`.
   - **description**: a one-line ask to review for correctness bugs first, then
     reuse/simplification/efficiency — then the **scope** (the git command + file list, or the
     fenced diff only if embedding), then the focus note from `$ARGUMENTS` if any. (Bob's review
     mode supplies its own rubric and findings format, so keep this short; don't over-specify.)

3. **Wait for Bob, then surface the findings.** Report the new task id and that it routes to
   `{review}`. First check `board_status` (its `worker_draining` reflects a **2.0 in-process loop** as well
   as a **1.x worker**): if `worker_draining.draining` is **false**, nothing is draining the board — tell
   the user it's **queued as #id** and to start a drainer (open the repo in a **Bob 2.0** window, whose
   in-process loop drains automatically, or run a **1.x** worker via `launch-worker.cmd`), then stop.
   Otherwise a drainer is live and step 2 tagged the task to its pin, so don't report "queued" for a
   tag-pinned drainer — call `await_task {task_id: id}`. It **blocks until the drainer runs the task and
   Bob settles it**, so the review comes back this turn:
   - `analysis_done` (or `done`) → the full review is in the task **`result`** plus a structured
     **`bob-review` note** (severity / location / category, with any `fixed_diff`). Surface the
     findings, correctness issues first.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, nothing is draining the board — tell the user
     it's **queued as #id** and to start a drainer (as above) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response). A **1.x** worker parks it on the board —
     surface it and have the user answer, then `await_task` again. A **2.0** in-process Bob has no board
     reply channel, so surface the question for the user to steer in Bob's window. `blocked` /
     `cancelled` → report Bob stopped, with the note reason.

Note: `await_task` only **waits** — Bob runs the task when a drainer pulls it (a 2.0 in-process loop or a
1.x worker), so this loop is autonomous only while one is draining the board; otherwise it falls back to
"queued as #id". `review` mode is read-only, safe to drain unattended. (If you want the review text returned
**inline** rather than via the board, file it in `ask` mode instead.)
