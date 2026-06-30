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
   - **tags**: `['refactor']` (+ a domain tag when obvious). If step-1 `worker_draining` shows a
     tag-pinned drainer serving this checkout, **add its pin tag too** — a worker only pulls tasks
     whose tags include its pin, else the task sits `pending`.
   - **priority**: infer; default `medium`.
   - **description**: name the files/scope, the desired end-state, and the constraints —
     especially **"Preserve behavior; keep the build and tests green."** Call out anything
     off-limits. `refactor` mode reads files and runs `git diff`/`git log` itself, so name the
     scope rather than pasting a big diff.

3. **Wait for Bob, then surface what changed.** Report the new task id and that it routes to
   `{refactor}`. Use the `worker_draining` from step 1 (it reflects a **2.0 in-process loop** as well as a
   **1.x worker**): if `worker_draining.draining` is **false**, nothing is draining the board — say it's
   **queued as #id** and tell the user to start a drainer (open the repo in a **Bob 2.0** window, whose
   in-process loop drains automatically, or run a **1.x** worker via `launch-worker.cmd`), then stop.
   Otherwise a drainer is live and step 2 tagged the task to its pin, so don't report "queued" for a
   tag-pinned drainer — call `await_task {task_id: id}`. It **blocks until the drainer runs the task and
   Bob settles it**, so the result comes back this turn:
   - `done` → summarize what Bob changed from the task **`result`** and remind the user to review
     the diff / run tests before merging.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, nothing is draining the board — say it's
     **queued as #id**; start a drainer (as above) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response). A **1.x** worker parks it on the board —
     surface it; once the user answers (`answer_task_question`) call `await_task` again. A **2.0**
     in-process Bob has no board reply channel, so surface the question for the user to steer in Bob's
     window (or re-file a follow-up with the answer baked in). `blocked` / `cancelled` → report Bob
     stopped, with the note reason (a refactor that couldn't keep tests green often lands here).
