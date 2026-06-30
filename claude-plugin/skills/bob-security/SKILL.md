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

2. **Decide the scope — let Bob gather it itself.** `devsecops` mode has the `read` + `command`
   groups (it can run `git diff` / scans itself), so hand it the *scope*, don't embed a big diff.
   Either a **diff** (recent changes) — name the files in scope and tell Bob to review them via
   `git diff HEAD -- <files>` (or an explicit `git diff <range>`) — or a **target area** (paths /
   subsystem). Only embed a fenced ```diff (bounded to ~12,000 chars, note truncation) when
   there's no git scope to point at, e.g. a diff pasted into the request.

3. **Shape the security task** with `create_task`:
   - **mode**: `devsecops`.
   - **title**: specific, e.g. `Security review: auth + input handling in src/api`.
   - **tags**: `['security']` (+ a domain tag when obvious). If step-1 `worker_draining` shows a
     tag-pinned drainer serving this checkout, **add its pin tag too** — a worker only pulls tasks
     whose tags include its pin, else the task sits `pending`.
   - **priority**: `high` for anything the user frames as a vuln/incident, else `medium`.
   - **description**: what to inspect (injection, authz, secrets/credentials, unsafe
     deserialization, path traversal, dependency risk, etc.), the scope (the git command + file
     list, or the fenced ```diff only if embedding), and ask Bob to **fix the vulnerabilities it
     finds** highest-severity first, and summarize what it changed (noting anything it flagged but
     deliberately left unfixed).

4. **Wait for Bob, then surface what was fixed.** Report the new task id and that it routes to
   `{devsecops}`. Use the `worker_draining` from step 1 (it reflects a **2.0 in-process loop** as well as a
   **1.x worker**): if `worker_draining.draining` is **false**, nothing is draining the board — say it's
   **queued as #id** and tell the user to start a drainer (open the repo in a **Bob 2.0** window, whose
   in-process loop drains automatically, or run a **1.x** worker via `launch-worker.cmd`), then stop.
   Otherwise a drainer is live and step 3 tagged the task to its pin, so don't report "queued" for a
   tag-pinned drainer — call `await_task {task_id: id}`. It **blocks until the drainer runs the task and
   Bob settles it**, so the result comes back this turn:
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
