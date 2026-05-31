---
description: Review the whole board and propose (then apply) triage fixes
argument-hint: "[optional: focus, e.g. 'blocked' or a tag]"
allowed-tools: mcp__bob-tasks__list_tasks, mcp__bob-tasks__get_task, mcp__bob-tasks__update_task_status, mcp__bob-tasks__add_task_note, mcp__bob-tasks__set_task_mode, mcp__bob-tasks__create_task, mcp__bob-tasks__delete_task
---

Act as the foreman doing a board review. Optional focus: **$ARGUMENTS**.

1. **Read the board.** Call `list_tasks` (no filter, or narrowed to the focus above).
   For anything ambiguous, `get_task` to read its notes.
2. **Diagnose.** Flag:
   - **blocked** tasks — what's the blocker, can it be unblocked or should it be cancelled?
   - **in_progress** tasks that look abandoned (claimed long ago, no recent notes).
   - **pending** tasks that are unclear: no description, missing acceptance criteria, or no obvious mode/tags.
   - **priority inversions** — low-priority noise ahead of real work, or urgent work buried.
   - **duplicates / overlap** between tasks.
3. **Propose a plan** as a short numbered list, each item: `#id → action (why)`.
4. **Apply after the user confirms** — all via tools, no shell needed:
   - re-open / block / cancel / mark done → `update_task_status`
   - leave a triage rationale on a task → `add_task_note`
   - set or clear a task's mode → `set_task_mode` (pass `''` to clear and let it auto-route)
   - remove a duplicate / mistake → `delete_task` (prefer `update_task_status` → `cancelled`
     when you want to keep a record)
   - change **priority** or **tags** (no in-place edit exists): `delete_task`, then `create_task`
     with the corrected priority/tags — carry over the title and description verbatim, and only
     do this for `pending` tasks (never re-create one that's mid-flight).

Be conservative: never cancel or close a task without the user's say-so. Default to a
note + recommendation when unsure.
