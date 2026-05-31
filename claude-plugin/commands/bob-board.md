---
description: Show the Bob task board grouped by status
argument-hint: "[optional: tag to filter by]"
allowed-tools: mcp__bob-tasks__list_tasks
---

Show the current Bob task board.

Call `list_tasks` (pass `tag: "$ARGUMENTS"` only if a tag was given above, otherwise
no filter). Then present a compact summary grouped by status in this order:
**in_progress, blocked, pending, done, cancelled**.

For each task show: `#id` · priority · title · `@assignee` (if any) · `{mode}` (if set)
· `[tags]`. Within a group, order by priority (urgent→low) then oldest first —
that's the order Bob will pull them.

End with a one-line count per status and call out anything that needs attention:
**blocked** tasks, **in_progress** tasks that look stale, or **pending** tasks with
no description. Keep it scannable — this is a status read, not an essay.
