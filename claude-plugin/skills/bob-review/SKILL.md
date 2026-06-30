---
name: bob-review
description: >-
  Dispatch a code review of a diff to IBM Bob (Bob's native `review` mode), which returns a
  prioritized, correctness-first findings list with suggested fixes. Use ONLY when the user
  explicitly wants IBM BOB (not you) to review code — e.g. "have Bob review this", "send these
  changes to Bob for review", "get Bob's review of the diff". Do NOT use for the user's own
  review requests, generic "review this" asks, or anything covered by Claude's own /code-review.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task, mcp__bob-tasks__board_status
---

You are the **foreman**. The user wants **IBM Bob** to code-review a set of changes in this
repo. Bob reviews in its read-only `review` mode — it never edits; it returns a structured
findings list (severity, location, category, often a `fixed_diff`). The auto-dispatch worker
now parses those findings onto the **board** (the task `result` plus a `bob-review` note), so
the findings come back to you — you don't need Bob's webview panel.

Do this:

1. **Get board state in one call.** Call `board_status` — it returns `open_tasks` (the live,
   non-terminal tasks) for the dedup check and `worker_draining` for step 4. Scan `open_tasks`
   for a near-identical **pending** review task; if one exists, point the user at it instead of
   creating another. (Ignore a `blocked`/`needs_input` near-match — it can't be pulled, so
   deduping against it would dead-end the request.) Only if `open_tasks_truncated` is true and
   you're unsure, fall back to `list_tasks {status: 'pending', tag: 'review'}`. `worker_draining`
   is a step-1 snapshot — keep it for step 4 rather than re-calling `board_status`.

2. **Scope the review — let Bob gather the diff itself.** Bob's `review` mode has the `read` +
   `command` groups and is told to run `git diff` / `git log` itself, so **don't embed a big
   diff** — hand Bob a *scope* and let it pull the diff.
   - **Explicit git range** (`$ARGUMENTS` has `..`, e.g. `main...HEAD`): review `git diff <range>`.
   - **Uncommitted changes** (default): from `git status --porcelain`, name the paths in scope —
     in a shared tree, **exclude unrelated in-progress work** — and review them via
     `git diff HEAD -- <files>` (untracked files by path).
   - **No working-tree changes** → branch vs base: `git diff @{upstream}...HEAD`, or
     `git diff main...HEAD` with no upstream.
   - **Only embed** when there's no git scope to point at (a diff pasted into the request, or not
     a repo): a fenced ```diff block, bounded to ~12,000 chars (note any truncation).
   - If there is genuinely **nothing to review**, say so and stop — don't create an empty task.

3. **File the review task** with `create_task`:
   - **mode**: `review` — Bob's native code-review mode (read-only, safe to drain unattended).
   - **title**: `Code review: <short summary of the change>` (imperative, specific).
   - **tags**: `['review']` (the dedup key). If step-1 `worker_draining` shows a tag-pinned drainer
     serving this checkout, **add its pin tag too** — a worker only pulls tasks whose tags include
     its pin, so a `review`-only task sits `pending` under one. Don't pad with tags it won't match
     (`code-review`, etc.).
   - **priority**: `high` if the user signals urgency, else `medium`.
   - **description**: a one-line ask to review for correctness bugs first, then reuse /
     simplification / efficiency — then the **scope** (the git command + file list, or the fenced
     diff only if embedding), then the user's focus note if any. Keep it short; review mode
     supplies its own rubric.

4. **Wait for Bob, then surface the findings.** Report the new task id and that it routes to
   `{review}`. Use the `worker_draining` from step 1 (it reflects a **2.0 in-process loop** as well as a
   **1.x worker**): if `worker_draining.draining` is **false**, nothing is draining the board — tell the
   user it's **queued as #id** and to start a drainer (open the repo in a **Bob 2.0** window, whose
   in-process loop drains automatically, or run a **1.x** worker via `launch-worker.cmd`), then stop.
   Otherwise a drainer is live and step 3 tagged the task to its pin, so don't report "queued" for a
   tag-pinned drainer — call `await_task {task_id: id}`. It **blocks until the drainer runs the task and
   Bob settles it**, so the review completes this turn:
   - `analysis_done` (or `done`) → the review is in the task **`result`** plus a structured
     **`bob-review` note** (severity / location / `fixed_diff`). Present the findings,
     correctness issues first.
   - `waiting` (the poll window elapsed) → call `await_task` again and keep waiting while Bob
     works. If it stays `waiting` across several calls, nothing is draining the board —
     tell the user it's **queued as #id** and to start a drainer (as above) or check
     `/bob-board`.
   - `needs_input` → Bob asked a question (it's in the response). A **1.x** worker parks it on the
     board — surface it; once the user answers (`answer_task_question` or the board) call `await_task`
     again. A **2.0** in-process Bob has no board reply channel, so surface the question for the user
     to steer in Bob's window (or re-file a follow-up with the answer baked in).
   - `blocked` / `cancelled` → Bob stopped without completing; report that with the reason from
     the task notes.
