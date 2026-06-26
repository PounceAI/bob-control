---
description: Preview which Bob mode a task id or a hypothetical description would route to
argument-hint: <task id | description text>
allowed-tools: mcp__bob-tasks__predict_mode
---

Predict the dispatch mode for: **$ARGUMENTS**

Call `predict_mode` — it routes via the connector's own router (`modes.ts`), so this never re-encodes
the keyword table and can't drift from it:

- If the argument is a **number**, pass it as `id` (routes the real task: its explicit `mode` › a tag
  naming a mode › the keyword auto-router › `code`).
- Otherwise pass the text as `text` (routes it as a hypothetical task title/description).

It returns `{mode, source, risk}`. Report:

- the chosen **mode** and the **source** (`explicit` / `tag` / `auto-router` / `default`);
- the **risk** (`safe` / `standard` / `elevated`). The worker auto-dispatches only at/below its
  `--max-risk` (default `standard`), so an `advanced` (elevated) task waits for manual dispatch.

If it routed somewhere the user probably didn't intend, suggest clearer wording or an explicit `mode`
to pin it.
