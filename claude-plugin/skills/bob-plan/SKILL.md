---
name: bob-plan
description: >-
  Ask IBM Bob to PLAN or design an approach without implementing it (Bob's read-only `plan`
  mode) — it returns an analysis / step-by-step plan, no code changes. Use ONLY when the user
  explicitly wants IBM BOB to plan or design something — e.g. "have Bob plan the migration",
  "ask Bob to design this", "get Bob's plan for X". Do NOT use for your own planning, generic
  "make a plan" asks, or Claude Code's plan mode.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task, mcp__bob-tasks__board_status
---

You are the **foreman**. The user wants **IBM Bob** to produce a plan/design — analysis only,
no implementation. Bob runs this in its read-only `plan` mode (it may read files and run safe
analysis commands, but writes nothing).

Do this:

1. **Get board state in one call.** Call `board_status` — it returns `open_tasks` (the live,
   non-terminal tasks) for the dedup check and `worker_draining` for step 3. Scan `open_tasks`
   for a near-identical **pending** planning task; if one exists, skip creating another and point
   the user at it. (Ignore a `blocked`/`needs_input` near-match — it can't be pulled, so deduping
   against it would dead-end the request.) Only if `open_tasks_truncated` is true and you're
   unsure, fall back to `list_tasks {status: 'pending'}`. `worker_draining` is a step-1 snapshot —
   keep it for step 3 rather than re-calling `board_status`.

2. **Shape the planning task** with `create_task`:
   - **mode**: `plan` — read-only analysis/design; no code changes.
   - **title**: imperative and specific, e.g. `Plan: migrate src/db.ts off the global handle`.
   - **tags**: `['plan']` (+ a domain tag when obvious: `rpg`, `sql`, `db`, `docs`). If step-1
     `worker_draining` shows a tag-pinned drainer serving this checkout, **add its pin tag too** —
     a worker only pulls tasks whose tags include its pin, else it sits `pending`.
   - **priority**: infer from the request; default `medium`.
   - **description**: the goal, the relevant context/constraints, and explicitly **"Produce a
     plan/design only — do NOT modify files or implement."** State what the plan should cover
     (steps, risks, files touched, alternatives). If the user pointed at specific code, name the
     paths — `plan` mode can read them and run `git diff` itself, so don't paste a big diff.

3. **Wait for Bob, then surface the plan.** Report the new task id and that it routes to
   `{plan}`. Use the `worker_draining` from step 1 (it reflects a **2.0 in-process loop** as well as a
   **1.x worker**): if `worker_draining.draining` is **false**, nothing is draining the board — say it's
   **queued as #id** and tell the user to start a drainer (open the repo in a **Bob 2.0** window, whose
   in-process loop drains automatically, or run a **1.x** worker via `launch-worker.cmd`), then stop.
   Otherwise a drainer is live and step 2 tagged the task to its pin, so don't report "queued" for a
   tag-pinned drainer — call `await_task {task_id: id}`. It **blocks until the drainer runs the task and
   Bob settles it**, so the plan comes back this turn:
   - `analysis_done` (or `done`) → present Bob's plan from the task **`result`**.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, nothing is draining the board — say it's
     **queued as #id**; start a drainer (as above) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response). A **1.x** worker parks it on the board —
     surface it; once the user answers (`answer_task_question`) call `await_task` again. A **2.0**
     in-process Bob has no board reply channel, so surface the question for the user to steer in Bob's
     window (or re-file a follow-up with the answer baked in). `blocked` / `cancelled` → report Bob
     stopped, with the note reason.

Note: this produces a plan, not an implementation. If the user then wants Bob to *build* it,
that's a separate `code`/`orchestrator` task (use `/bob-new`).
