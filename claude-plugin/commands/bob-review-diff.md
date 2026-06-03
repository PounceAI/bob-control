---
description: Send the diff you just made to Bob for a read-only (ask-mode) code review
argument-hint: "[optional: a focus note, or a git ref range like main...HEAD]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git rev-parse:*), mcp__bob-tasks__create_task, mcp__bob-tasks__get_task, mcp__bob-tasks__list_tasks
---

You are the **foreman**. The user wants **Bob** to code-review the changes that were just
made in this repo (typically the ones *you* made this session). Bob reviews in read-only
`ask` mode — it never edits; it returns a findings list.

Optional argument (focus note, or an explicit git ref range):

> $ARGUMENTS

Do this:

1. **Gather the diff to review.**
   - If `$ARGUMENTS` contains a ref range (has `..`, e.g. `main...HEAD` or `HEAD~3..HEAD`),
     review that: `git diff <range>`.
   - Otherwise review the **uncommitted working-tree changes** (the ones just made):
     run `git diff HEAD` and `git status --porcelain`. Include new/untracked files —
     `git add --intent-to-add -- <newfiles>` then `git diff HEAD`, then
     `git reset -- <newfiles>` to leave the index untouched (or just note new files by path
     if that's simpler).
   - If `git diff HEAD` is empty, fall back to the branch vs its base:
     `git diff @{upstream}...HEAD`, or `git diff main...HEAD` if there's no upstream.
   - If there is genuinely **nothing to review**, say so and stop — don't create an empty task.
   - **Bound it:** if the diff exceeds ~12,000 characters, include the most relevant hunks
     and state clearly in the task that it was truncated (and to what).

2. **File the review task** with `create_task`:
   - **mode**: `review` — Bob's **native code-review mode**. It runs read-only and writes
     structured issues to Bob's **findings panel**, many with a suggested `fixed_diff`.
   - **title**: `Code review: <short summary of the change>` (imperative, specific).
   - **tags**: `['code-review', 'review']`.
   - **priority**: `high` if the user signals urgency, else `medium`.
   - **description**: a one-line ask to review the diff for correctness bugs first, then
     reuse/simplification/efficiency — then the diff in a fenced ```diff block, then the
     focus note from `$ARGUMENTS` if any. (Bob's review mode supplies its own rubric and
     findings format, so keep this short; don't over-specify.)

3. **Surface the result.** Report the new task id and that it routes to `{review}`. Then call
   `get_task` on it once or twice:
   - When Bob's worker has drained it (status `done`), the full review is in the task
     **`result`** and the worker also persists a structured **`bob-review` note** (findings
     parsed into severity / location / category, with any `fixed_diff`). Surface those
     findings to the user. **Note:** under headless dispatch review mode returns the review as
     completion text rather than writing to Bob's webview findings panel, so the board — not
     the panel — is the source of truth here.
   - If it's still `pending`/`in_progress`, tell the user it's **queued as #id** — Bob reviews
     it when its worker pulls — and they can re-run this command or `/bob-board` to check status.

Note: this command **queues** the review on the shared board; the run happens when Bob's
auto-dispatch worker pulls the task. `review` mode is read-only, so it's safe to drain
unattended. (If you instead want the full review text returned **inline in Claude Code**
rather than in Bob's panel, file it in `ask` mode — Bob then returns the review as the task
result.)
