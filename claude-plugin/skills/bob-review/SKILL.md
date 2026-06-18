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

2. **Gather the diff to review.** Review mode is tool-restricted under headless dispatch (it
   can't run git itself), so the diff must be **embedded in the task**.
   - If the user gave an explicit git range (has `..`, e.g. `main...HEAD` or `HEAD~3..HEAD`),
     use `git diff <range>`.
   - Otherwise review the **uncommitted working-tree changes**: `git diff HEAD` plus
     `git status --porcelain`. Include new/untracked files — `git add --intent-to-add -- <files>`,
     `git diff HEAD`, then `git reset -- <files>` to leave the index untouched.
   - If `git diff HEAD` is empty, fall back to the branch vs its base:
     `git diff @{upstream}...HEAD`, or `git diff main...HEAD` if there's no upstream.
   - If there is genuinely **nothing to review**, say so and stop — don't create an empty task.
   - **Bound it:** if the diff exceeds ~12,000 characters, include the most relevant hunks and
     state in the task that it was truncated (and to what).

3. **File the review task** with `create_task`:
   - **mode**: `review` — Bob's native code-review mode (read-only, safe to drain unattended).
   - **title**: `Code review: <short summary of the change>` (imperative, specific).
   - **tags**: `['code-review', 'review']`.
   - **priority**: `high` if the user signals urgency, else `medium`.
   - **description**: a one-line ask to review the diff for correctness bugs first, then
     reuse / simplification / efficiency — then the diff in a fenced ```diff block, then the
     user's focus note if any. Keep it short; review mode supplies its own rubric.

4. **Wait for Bob, then surface the findings.** Report the new task id and that it routes to
   `{review}`. Use the `worker_draining` from step 1: if `worker_draining.draining` is **false**, no worker
   will pull this — tell the user it's **queued as #id** and to start one (`launch-worker.cmd`), then
   stop. Otherwise call `await_task {task_id: id}` — it **blocks until the worker drains the task
   and Bob settles it**, so the whole review loop completes in this one turn (no "check back later"):
   - `analysis_done` (or `done`) → the review is in the task **`result`** plus a structured
     **`bob-review` note** (severity / location / `fixed_diff`). Present the findings,
     correctness issues first.
   - `waiting` (the poll window elapsed) → call `await_task` again and keep waiting while Bob
     works. If it stays `waiting` across several calls, **no worker is draining the board** —
     tell the user it's **queued as #id** and to start the worker (`npm run worker`) or check
     `/bob-board`.
   - `needs_input` → Bob asked a question (it's in the response); surface it and have the user
     answer (`answer_task_question` or the board), then `await_task` again.
   - `blocked` / `cancelled` → Bob stopped without completing; report that with the reason from
     the task notes.
