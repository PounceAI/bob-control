---
name: bob-refactor
description: >-
  Hand a refactor/restructure job to IBM Bob (Bob's `refactor` mode) — behavior-preserving
  cleanup, renames, extraction, de-duplication, edits the code. Use ONLY when the user
  explicitly wants IBM BOB to refactor or restructure code — e.g. "have Bob refactor this
  module", "ask Bob to clean up X", "get Bob to restructure Y". Do NOT use for your own
  refactors or generic "refactor this" asks you'd do yourself.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task, mcp__bob-tasks__board_status
---

You are the **foreman**. The user wants **IBM Bob** to refactor/restructure code. Bob's
`refactor` mode edits files (standard risk: it can write and run build/test commands), so the
task should make the **behavior-preserving** intent explicit and name the target.

Do this:

1. **Get board state in one call.** Call `board_status` — it returns `open_tasks` (the live,
   non-terminal tasks) for the dedup check and `worker_draining` for step 3. Scan `open_tasks`
   for a near-identical **pending** refactor task; if one exists, skip creating another and point
   the user at it. (Ignore a `blocked`/`needs_input` near-match — it can't be pulled, so deduping
   against it would dead-end the request.) Only if `open_tasks_truncated` is true and you're
   unsure, fall back to `list_tasks {status: 'pending'}`. `worker_draining` is a step-1 snapshot —
   keep it for step 3 rather than re-calling `board_status`.

2. **Shape the refactor task** with `create_task`:
   - **mode**: `refactor`.
   - **title**: imperative and specific, e.g. `Refactor src/worker.ts: extract dispatch loop`.
   - **tags**: `['refactor']` plus a domain tag when obvious.
   - **priority**: infer; default `medium`.
   - **description**: name the files/scope, the desired end-state, and the constraints —
     especially **"Preserve behavior; keep the build and tests green."** Call out anything
     off-limits. If useful, include the current `git diff`/`git log` context, bounded.

3. **Wait for Bob, then surface what changed.** Report the new task id and that it routes to
   `{refactor}`. Use the `worker_draining` from step 1: if `worker_draining.draining` is **false**, no worker will
   pull this — say it's **queued as #id** and tell the user to start one (`launch-worker.cmd`),
   then stop. Otherwise call `await_task {task_id: id}` — it **blocks until the worker drains the
   task and Bob settles it**, so the result comes back in this same turn:
   - `done` → summarize what Bob changed from the task **`result`** and remind the user to review
     the diff / run tests before merging.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, **no worker is draining the board** — say it's
     **queued as #id**; start the worker (`npm run worker`) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response); surface it for the user to answer,
     then `await_task` again. `blocked` / `cancelled` → report Bob stopped, with the note reason
     (a refactor that couldn't keep tests green often lands here).
