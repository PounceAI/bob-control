---
description: Show the next task Bob would pull, and the mode it will route to
argument-hint: "[optional: tag to filter by]"
allowed-tools: mcp__bob-tasks__get_next_task, mcp__bob-tasks__get_task
---

Show what Bob will pull next — **without claiming it** (you are the foreman, not the
worker; do not set `claim`).

Call `get_next_task` with `claim: false` (and `tag: "$ARGUMENTS"` only if a tag was
given above). If it returns null, say the queue is empty and stop.

Otherwise report:
- the task: `#id` · priority · title, plus its description and tags;
- **the mode it will dispatch in**, derived from these rules (first match wins):
  1. an explicit `mode` on the task → use it (source: explicit);
  2. else a tag that names a mode (`ask`/`code`/`advanced`/`orchestrator`) → that mode (source: tag);
  3. else the keyword router on title+description+tags:
     `advanced` (browser/url/scrape/screenshot/http/fetch) ›
     `orchestrator` (orchestrate/coordinate/multi-step/break down/sub-tasks/workflow/epic) ›
     `ask` (explain/describe/document/summarize/analyze/research/investigate/what is/how does) ›
     else `code` (source: auto-router);
  4. else `code` (source: default).
- the risk level of that mode: `ask`=safe, `code`/`orchestrator`=standard, `advanced`=elevated.
  Note that the worker only auto-dispatches at or below its `--max-risk` (default `standard`),
  so an `advanced` task will wait for manual dispatch.

State the mode, the source, and a one-line "why". Do not change the task.
