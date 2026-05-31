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

1. **Survey.** `list_tasks` with `status: "pending"` (and the tag filter if given). The list
   is already in pull order (priority, then oldest). Never touch tasks that are already
   `in_progress` — someone (maybe Bob) owns them.
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
   - **`ask` (read-only):** investigate and report only. Do **not** edit, write, or run
     mutating commands. Your `result` is the findings.
   - **`code` / `orchestrator`:** implement the change — edit, build, run, verify.
   - **`advanced`:** proceed only if you have the capability it needs. If you don't, there
     is no unclaim action, so set `update_task_status` → `blocked` with a note saying what's missing.
6. **Do the work**, leaving a brief `add_task_note` (`author: "claude"`) at meaningful
   milestones — not after every step.
7. **Finish:**
   - **Success →** `submit_result` with `id` and a concise `result`: what you changed (name
     the files), how you verified it, and anything the reviewer should know. This marks it
     done.
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
