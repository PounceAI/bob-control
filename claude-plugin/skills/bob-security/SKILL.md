---
name: bob-security
description: >-
  Request a security / DevSecOps review or scan from IBM Bob (Bob's `devsecops` mode) — it
  inspects code for vulnerabilities, insecure patterns, secrets, and dependency risks. Use ONLY
  when the user explicitly wants IBM BOB to do security work — e.g. "have Bob do a security
  review", "ask Bob to scan this for vulnerabilities", "get Bob's devsecops review". Do NOT use
  for your own security analysis or Claude Code's /security-review.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks, mcp__bob-tasks__await_task, mcp__bob-tasks__board_status
---

You are the **foreman**. The user wants **IBM Bob** to do security / DevSecOps work. Bob runs
this in its `devsecops` mode — security embedded in coding (IBM's shift-left model): it reads
code, runs analysis/scan commands, **and edits code to remediate** the vulnerabilities it finds
(standard risk, write-capable). The auto-dispatch worker's LLM judge verifies the fix diff, so
phrase the task as "find **and fix**", not just "report".

Do this:

1. **Get board state in one call.** Call `board_status` — it returns `open_tasks` (the live,
   non-terminal tasks) for the dedup check and `worker_draining` for step 4. Scan `open_tasks`
   for a near-identical **pending** security task; if one exists, skip creating another and point
   the user at it. (Ignore a `blocked`/`needs_input` near-match — it can't be pulled, so deduping
   against it would dead-end the request.) Only if `open_tasks_truncated` is true and you're
   unsure, fall back to `list_tasks {status: 'pending'}`. `worker_draining` is a step-1 snapshot —
   keep it for step 4 rather than re-calling `board_status`.

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
   `{devsecops}`. Use the `worker_draining` from step 1 (it reflects a **2.0 in-process loop** as well as a
   **1.x worker**): if `worker_draining.draining` is **false**, nothing is draining the board — say it's
   **queued as #id** and tell the user to start a drainer (open the repo in a **Bob 2.0** window, whose
   in-process loop drains automatically, or run a **1.x** worker via `launch-worker.cmd`), then stop.
   Otherwise call `await_task {task_id: id}` — it **blocks until the drainer runs the task and Bob settles
   it**, so the result comes back in this same turn:
   - `done` → present what Bob **fixed** from the task **`result`** (highest-severity first), plus
     any residual risks it flagged. The diff is on the working tree for the user to review.
   - `waiting` (poll window elapsed) → call `await_task` again; keep waiting while Bob works. If
     it stays `waiting` across several calls, nothing is draining the board — say it's
     **queued as #id**; start a drainer (as above) or check `/bob-board`.
   - `needs_input` → Bob asked a question (in the response). A **1.x** worker parks it on the board —
     surface it; once the user answers (`answer_task_question`) call `await_task` again. A **2.0**
     in-process Bob has no board reply channel, so surface the question for the user to steer in Bob's
     window (or re-file a follow-up with the answer baked in). `blocked` / `cancelled` → report Bob
     stopped, with the note reason.
