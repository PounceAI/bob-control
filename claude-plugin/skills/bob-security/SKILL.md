---
name: bob-security
description: >-
  Request a security / DevSecOps review or scan from IBM Bob (Bob's `devsecops` mode) — it
  inspects code for vulnerabilities, insecure patterns, secrets, and dependency risks. Use ONLY
  when the user explicitly wants IBM BOB to do security work — e.g. "have Bob do a security
  review", "ask Bob to scan this for vulnerabilities", "get Bob's devsecops review". Do NOT use
  for your own security analysis or Claude Code's /security-review.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task
---

You are the **foreman**. The user wants **IBM Bob** to do security / DevSecOps work. Bob runs
this in its `devsecops` mode — security embedded in coding (IBM's shift-left model): it reads
code, runs analysis/scan commands, **and edits code to remediate** the vulnerabilities it finds
(standard risk, write-capable). The auto-dispatch worker's LLM judge verifies the fix diff, so
phrase the task as "find **and fix**", not just "report".

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
     ```diff block), and ask Bob to **fix the vulnerabilities it finds**, highest-severity first,
     and summarize what it changed (note anything it flagged but deliberately left unfixed).

4. **Wait for Bob, then surface what was fixed.** Report the new task id and that it routes to
   `{devsecops}`, then call `await_task {task_id: id}` — it **blocks until Bob's worker drains the
   task and Bob settles it**, so the result comes back in this same turn:
   - `done` → present what Bob **fixed** from the task **`result`** (highest-severity first), plus
     any residual risks it flagged. The diff is on the working tree for the user to review.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, **no worker is draining the board** — say it's
     **queued as #id**; start the worker (`npm run worker`) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response); surface it for the user to answer,
     then `await_task` again. `blocked` / `cancelled` → report Bob stopped, with the note reason.
