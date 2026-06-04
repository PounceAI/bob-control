---
description: Preview which Bob mode a task id or a hypothetical description would route to
argument-hint: <task id | description text>
allowed-tools: mcp__bob-tasks__get_task
---

Predict the dispatch mode for: **$ARGUMENTS**

- If the argument is a **number**, call `get_task` with that id and route the real
  task (title + description + tags + any explicit mode).
- Otherwise treat the text as a **hypothetical** task title/description and route that.

Apply the dispatcher's resolution order — **first match wins**:

1. **explicit** — task has a `mode` set → use it.
2. **tag** — a tag naming a built-in mode (`ask` / `code` / `advanced` / `orchestrator` / `plan` / `review` / `devsecops` / `refactor`) → that mode.
3. **auto-router** — scan title + description + tags, first match wins. The read-only modes
   (`review` / `plan` / `ask`) are skipped when the task has an implementation verb, so impl work
   isn't stranded in a no-write mode:
   - `review` — `review the diff/code/changes/PR/implementation` (read-only findings)
   - `plan` — `plan/design/outline/propose` the `approach/strategy/rollout/architecture` (read-only)
   - `devsecops` — `security scan/review/audit, vulnerability, CVE, secrets scan, threat model, OWASP, pentest`
   - `advanced` — `browser, webpage, website, url, scrape, crawl, navigate, screenshot, mcp tool, fetch the, http(s)`
   - `orchestrator` — `orchestrate, coordinate, multi-step, break down, sub-tasks, workflow, epic, several steps`
   - `ask` — `explain, describe, document, docs, summarize, analyze, research, investigate, what is, what are, how does, how do, why does, why is, question, clarify, review the concept/approach/design, understand`
4. **default** — none of the above → `code`.

Report: the chosen **mode**, the **source** (explicit / tag / auto-router / default),
the matched keyword (if any), and the mode's **risk** (`ask`/`plan`/`review`=safe,
`code`/`orchestrator`/`refactor`/`devsecops`=standard, `advanced`=elevated). If it routed somewhere
the user probably didn't intend, suggest a clearer wording or an explicit `--mode` / `mode` to pin it.
