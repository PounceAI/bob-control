---
description: Drain the board as a worker — claim pending tasks Claude can do, execute them, submit results
argument-hint: "[tag] [--max N] [--dry-run] [--one]"
---

You are now the **worker** (not the foreman). Pull pending tasks off the Bob board,
**do the work yourself in this environment**, log progress, and submit results. Bob is
the other worker on this same board and handles the IBM i / RPG work — you take what you
can actually do here. Claiming a task marks it `in_progress`, and Bob only pulls
`pending`, so claiming is how the two of you avoid double-working a task.

## Options (parse from: $ARGUMENTS)

- a bare word → treat as a **tag** filter (only tasks carrying that tag).
- `--max N` → process at most N tasks (default **5**). A safety cap, not a target.
- `--one` → process a single task, then stop.
- `--dry-run` → show what you'd claim and your plan; **claim nothing, change nothing**, then stop.

## Loop

Repeat until the queue is empty, `--max` is hit, or only unsuitable tasks remain:

1. **Survey.** First call `board_status`. **If `armed` is false, STOP** — dispatch is paused
   (a curator is triaging); report that the board is disarmed and do nothing. Otherwise
   `list_tasks` with `status: "pending"` (and the tag filter if given). The list is already
   in pull order (priority, then oldest). `staged` tasks are deliberately NOT pullable and
   won't appear; never try to claim one. Never touch `in_progress` tasks — someone owns them.
2. **Pick the highest-priority task you can actually do here.** Skip — do **not** claim:
   - **Bob's domain:** IBM i / RPG work — tags like `rpg`, `rpgle`, `cl`, `cobol`, `db2`,
     `ibm-i`, `iseries`; or descriptions mentioning RPG, source members, `*LIBL`, DDS,
     5250/green-screen, service programs. Leave these `pending` for Bob.
   - **Out of reach:** work targeting code, paths, or resources not present in the current
     working directory.
   - **Capability you lack:** an `advanced` task that needs a browser/tool you don't have.
   If nothing is suitable, stop and report what's left and why you skipped it.
3. **Dry run?** If `--dry-run`, list the task(s) you'd take and a one-line plan for each,
   then stop without claiming.
4. **Claim it:** `claim_task` with `id` and `assignee: "claude"` (distinguishes your work
   from Bob's). Add a starting note: `add_task_note` with `author: "claude"`, e.g.
   "Claimed by Claude Code; starting."
5. **Resolve the mode and respect its risk** (same rules as `/bob-route`): explicit `mode`
   › a tag naming a mode › keyword router › `code`. Then:
   - **`ask` / `plan` / `review` (read-only):** investigate and report only. Do **not** edit,
     write, or run mutating commands. Your `result` is the findings. These finish as
     `analysis_done` (the board's distinct "analysis, not built/verified" state) — that is
     the correct, honest outcome, NOT a failure.
   - **`code` / `orchestrator`:** implement the change — edit, build, run, verify.
   - **`advanced`:** proceed only if you have the capability it needs. If you don't, there
     is no unclaim action, so set `update_task_status` → `blocked` with a note saying what's missing.
6. **Do the work**, leaving a brief `add_task_note` (`author: "claude"`) at meaningful
   milestones — not after every step. **Output discipline:** put analysis, plans, and design
   notes in the task `result`/notes — do **not** scatter `*_PLAN.md` / `*_DESIGN.md` files at
   arbitrary repo paths. If you genuinely need scratch files, keep them under a gitignored
   scratch dir, and `record_artifact` each one you write.
7. **Finish:**
   - **Implementation success →** `submit_result` with a concise `result` AND **`evidence`**
     (the `files` you changed, and a `test`/`commit` if you have one). Evidence is what lets
     an implementation task reach `done`; without it the task lands in `analysis_done`
     ("you described it but didn't build/verify it"). Don't claim done for a task you only
     analyzed — that's the false-done the gate exists to prevent.
   - **Analysis success (read-only modes) →** `submit_result` with your findings as `result`
     (no evidence needed); it completes as `analysis_done`.
   - **Can't complete** (missing info, environment can't do it, repeated errors, or it
     would require a destructive/irreversible action you shouldn't take unattended) →
     `update_task_status` → `blocked` **and** `add_task_note` (`author: "claude"`) saying
     exactly what's blocking it and what's needed. Never leave a task dangling in
     `in_progress`, and never force a risky action — surface it to the user instead.
8. **Serial only:** fully finish one task before claiming the next, so the board stays
   consistent and you're not fanning out edits across tasks.

## Report

End with a compact table — one row per task touched: `#id` · title · **outcome**
(done / blocked / skipped) · one-line note. Then state how many remain pending and whether
any need a human or Bob.
