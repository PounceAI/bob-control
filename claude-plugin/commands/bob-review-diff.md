---
description: Send the diff you just made to Bob for a read-only (ask-mode) code review
argument-hint: "[optional: a focus note, or a git ref range like main...HEAD]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task, mcp__bob-tasks__board_status
---

You are the **foreman**. The user wants **Bob** to code-review the changes that were just
made in this repo (typically the ones *you* made this session). Bob reviews in read-only
`ask` mode — it never edits; it returns a findings list.

Optional argument (focus note, or an explicit git ref range):

> $ARGUMENTS

Do this:

1. **Gather the diff to review.**
   - If `$ARGUMENTS` contains a ref range (has `..`, e.g. `main...HEAD` or `HEAD~3..HEAD`),
     review that: `git diff <range>`.
   - Otherwise review the **uncommitted working-tree changes** (the ones just made):
     run `git diff HEAD` and `git status --porcelain`. Include new/untracked files —
     `git add --intent-to-add -- <newfiles>` then `git diff HEAD`, then
     `git reset -- <newfiles>` to leave the index untouched (or just note new files by path
     if that's simpler).
   - If `git diff HEAD` is empty, fall back to the branch vs its base:
     `git diff @{upstream}...HEAD`, or `git diff main...HEAD` if there's no upstream.
   - If there is genuinely **nothing to review**, say so and stop — don't create an empty task.
   - **Bound it:** if the diff exceeds ~12,000 characters, include the most relevant hunks
     and state clearly in the task that it was truncated (and to what).

2. **File the review task** with `create_task`:
   - **mode**: `review` — Bob's **native code-review mode**. It runs read-only and writes
     structured issues to Bob's **findings panel**, many with a suggested `fixed_diff`.
   - **title**: `Code review: <short summary of the change>` (imperative, specific).
   - **tags**: `['code-review', 'review']`.
   - **priority**: `high` if the user signals urgency, else `medium`.
   - **description**: a one-line ask to review the diff for correctness bugs first, then
     reuse/simplification/efficiency — then the diff in a fenced ```diff block, then the
     focus note from `$ARGUMENTS` if any. (Bob's review mode supplies its own rubric and
     findings format, so keep this short; don't over-specify.)

3. **Wait for Bob, then surface the findings.** Report the new task id and that it routes to
   `{review}`. First check `board_status`: if `worker_draining.draining` is **false**, no worker will
   pull this — tell the user it's **queued as #id** and to start one (`launch-worker.cmd`), then
   stop. Otherwise call `await_task {task_id: id}` — it **blocks until the worker drains the task
   and Bob settles it**, so the review comes back in this same turn:
   - `analysis_done` (or `done`) → the full review is in the task **`result`** plus a structured
     **`bob-review` note** (severity / location / category, with any `fixed_diff`). Surface the
     findings. **Note:** under headless dispatch review mode returns the review as completion
     text, not to Bob's webview panel — the board is the source of truth.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, **no worker is draining the board** — tell the user
     it's **queued as #id** and to start the worker (`npm run worker`) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response); surface it and have the user answer,
     then `await_task` again. `blocked` / `cancelled` → report Bob stopped, with the note reason.

Note: `await_task` only **waits** — Bob runs the task when his auto-dispatch worker pulls it, so
this loop is autonomous only while a worker is draining the board (`npm run worker`); otherwise it
falls back to "queued as #id". `review` mode is read-only, safe to drain unattended. (If you want
the review text returned **inline** rather than via the board, file it in `ask` mode instead.)
