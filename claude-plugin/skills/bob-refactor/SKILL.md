---
name: bob-refactor
description: >-
  Hand a refactor/restructure job to IBM Bob (Bob's `refactor` mode) — behavior-preserving
  cleanup, renames, extraction, de-duplication, edits the code. Use ONLY when the user
  explicitly wants IBM BOB to refactor or restructure code — e.g. "have Bob refactor this
  module", "ask Bob to clean up X", "get Bob to restructure Y". Do NOT use for your own
  refactors or generic "refactor this" asks you'd do yourself.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks
---

You are the **foreman**. The user wants **IBM Bob** to refactor/restructure code. Bob's
`refactor` mode edits files (standard risk: it can write and run build/test commands), so the
task should make the **behavior-preserving** intent explicit and name the target.

Do this:

1. **Check for duplicates.** Call `list_tasks` (status `pending`); skip a near-identical
   refactor task and point the user at it instead.

2. **Shape the refactor task** with `create_task`:
   - **mode**: `refactor`.
   - **title**: imperative and specific, e.g. `Refactor src/worker.ts: extract dispatch loop`.
   - **tags**: `['refactor']` plus a domain tag when obvious.
   - **priority**: infer; default `medium`.
   - **description**: name the files/scope, the desired end-state, and the constraints —
     especially **"Preserve behavior; keep the build and tests green."** Call out anything
     off-limits. If useful, include the current `git diff`/`git log` context, bounded.

3. **Surface the result.** Report the new task id and that it routes to `{refactor}`. Then
   `get_task`:
   - When `done`, summarize what Bob changed from the task **`result`** and remind the user to
     review the diff / run tests before merging.
   - If still `pending`/`in_progress`, say it's **queued as #id** (check `/bob-board`).
