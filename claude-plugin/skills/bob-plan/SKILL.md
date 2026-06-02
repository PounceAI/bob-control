---
name: bob-plan
description: >-
  Ask IBM Bob to PLAN or design an approach without implementing it (Bob's read-only `plan`
  mode) — it returns an analysis / step-by-step plan, no code changes. Use ONLY when the user
  explicitly wants IBM BOB to plan or design something — e.g. "have Bob plan the migration",
  "ask Bob to design this", "get Bob's plan for X". Do NOT use for your own planning, generic
  "make a plan" asks, or Claude Code's plan mode.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks
---

You are the **foreman**. The user wants **IBM Bob** to produce a plan/design — analysis only,
no implementation. Bob runs this in its read-only `plan` mode (it may read files and run safe
analysis commands, but writes nothing).

Do this:

1. **Check for duplicates.** Call `list_tasks` (status `pending`); skip a near-identical
   planning task and point the user at it instead.

2. **Shape the planning task** with `create_task`:
   - **mode**: `plan` — read-only analysis/design; no code changes.
   - **title**: imperative and specific, e.g. `Plan: migrate src/db.ts off the global handle`.
   - **tags**: `['plan']` plus a domain tag when obvious (`rpg`, `sql`, `db`, `docs`).
   - **priority**: infer from the request; default `medium`.
   - **description**: the goal, the relevant context/constraints, and explicitly **"Produce a
     plan/design only — do NOT modify files or implement."** State what the plan should cover
     (steps, risks, files touched, alternatives). If the user pointed at specific code, name
     the paths; you may include a short `git diff` excerpt for context, but keep it bounded.

3. **Surface the result.** Report the new task id and that it routes to `{plan}`. Then
   `get_task`:
   - When `done`, present Bob's plan from the task **`result`**.
   - If still `pending`/`in_progress`, say it's **queued as #id** and Bob will plan it when its
     worker pulls (check `/bob-board`).

Note: this produces a plan, not an implementation. If the user then wants Bob to *build* it,
that's a separate `code`/`orchestrator` task (use `/bob-new`).
