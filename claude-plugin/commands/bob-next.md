---
description: Show the next task Bob would pull, and the mode it will route to
argument-hint: "[optional: tag to filter by]"
allowed-tools: mcp__bob-tasks__get_next_task, mcp__bob-tasks__predict_mode
---

Show what Bob will pull next — **without claiming it** (you are the foreman, not the
worker; do not set `claim`).

Call `get_next_task` with `claim: false` (and `tag: "$ARGUMENTS"` only if a tag was
given above). If it returns null, say the queue is empty — or, if it reports
`board: "disarmed"`, that dispatch is paused (arm the board to pull) — and stop.

Otherwise call `predict_mode { id: <that task's id> }` (it routes via the connector's own router
in `modes.ts`, so this never re-encodes the keyword table) and report:

- the task: `#id` · priority · title, plus its description and tags;
- **the mode it will dispatch in** and the **source** (`explicit` / `tag` / `auto-router` / `default`);
- the **risk** of that mode (`safe` / `standard` / `elevated`). The worker auto-dispatches only at/below
  its `--max-risk` (default `standard`), so an `advanced` (elevated) task waits for manual dispatch.

State the mode, the source, and a one-line "why" (for an `explicit`/`tag` source, name the mode or tag
that pinned it; for `auto-router`, the wording that matched). Do not change the task.
