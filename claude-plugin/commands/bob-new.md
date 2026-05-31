---
description: Provision a well-formed task onto the Bob board from a rough description
argument-hint: "[rough description of the work]"
allowed-tools: mcp__bob-tasks__create_task, mcp__bob-tasks__list_tasks
---

You are the **foreman** for IBM Bob. The user has handed you a rough piece of work;
turn it into one clean, well-formed task on the board so Bob can pull and run it.

Rough request:

> $ARGUMENTS

Do this:

1. **Check for duplicates first.** Call `list_tasks` (status `pending`) and skip
   creating anything that already exists; tell the user if you find a near-match.
2. **Shape the task**, then call `create_task` once with:
   - **title** — short, action-oriented, imperative (e.g. "Refactor src/db.ts to drop the global handle"). Not a sentence.
   - **description** — context + concrete acceptance criteria. State what "done" means and any constraints. If the work is read-only, say "Do NOT modify files."
   - **priority** — `low` | `medium` | `high` | `urgent`. Infer from the request; default `medium`. Use `high`/`urgent` only when the user signals it.
   - **tags** — short labels for filtering, e.g. `['rpg','refactor']`. Include a domain tag when obvious (`rpg`, `sql`, `db`, `docs`).
   - **mode** — usually **omit it** and let the dispatcher auto-route. Set it explicitly only when the user is specific. Valid modes and what they mean:
     - `ask` — read-only (explain / research / review / document). Safe; no writes or commands.
     - `code` — normal edit + build + run. The default.
     - `advanced` — adds Browser + MCP power. Use for anything touching a website/URL/scrape/screenshot.
     - `orchestrator` — coordinating a multi-step epic with sub-tasks.

**How the auto-router will read your task** (so you can pick tags/wording that route well — it matches title + description + tags, first rule wins):
- → `advanced` if it mentions browser, webpage, website, url, scrape, crawl, navigate, screenshot, mcp tool, fetch the, http(s).
- → `orchestrator` if it mentions orchestrate, coordinate, multi-step, break down, sub-tasks, workflow, epic, several steps.
- → `ask` if it mentions explain, describe, document, docs, summarize, analyze, research, investigate, "what is", "what are", "how does", "how do", "why does", "why is", question, clarify, understand, review the concept/approach/design.
- → `code` otherwise.
- A tag that names a mode (`ask`, `code`, `advanced`, `orchestrator`) is treated as a mode hint.

After creating it, report the new task id, the title, and the mode it will route to (with a one-line "why"). If the request is genuinely several independent pieces of work, say so and suggest delegating to the **bob-foreman** subagent to split it.
