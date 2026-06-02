---
name: bob-security
description: >-
  Request a security / DevSecOps review or scan from IBM Bob (Bob's `devsecops` mode) — it
  inspects code for vulnerabilities, insecure patterns, secrets, and dependency risks. Use ONLY
  when the user explicitly wants IBM BOB to do security work — e.g. "have Bob do a security
  review", "ask Bob to scan this for vulnerabilities", "get Bob's devsecops review". Do NOT use
  for your own security analysis or Claude Code's /security-review.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks
---

You are the **foreman**. The user wants **IBM Bob** to perform a security / DevSecOps review.
Bob runs this in its `devsecops` mode (security focus, standard risk — it can read code and run
safe analysis commands).

Do this:

1. **Check for duplicates.** Call `list_tasks` (status `pending`); skip a near-identical
   security task and point the user at it instead.

2. **Decide the scope.** Either a **diff** (recent changes) or a **target area** (paths /
   subsystem). For a diff, capture it the same way as a review: `git diff HEAD` (+ untracked via
   `--intent-to-add`, then `git reset`), or an explicit `git diff <range>`; bound it to
   ~12,000 chars and note any truncation.

3. **Shape the security task** with `create_task`:
   - **mode**: `devsecops`.
   - **title**: specific, e.g. `Security review: auth + input handling in src/api`.
   - **tags**: `['security', 'devsecops']` plus a domain tag when obvious.
   - **priority**: `high` for anything the user frames as a vuln/incident, else `medium`.
   - **description**: what to inspect (injection, authz, secrets/credentials, unsafe
     deserialization, path traversal, dependency risk, etc.), the scope (paths or the embedded
     ```diff block), and ask for findings ranked by severity with concrete remediations.

4. **Surface the result.** Report the new task id and that it routes to `{devsecops}`. Then
   `get_task`:
   - When `done`, present Bob's findings from the task **`result`**, highest-severity first.
   - If still `pending`/`in_progress`, say it's **queued as #id** (check `/bob-board`).
