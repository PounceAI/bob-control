# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [1.1.0] — 2026-06-25

The **final Bob-1.x release** — see [Compatibility](#compatibility-1x-vs-2x) below.

### Added — run N worktrees of one repo in parallel

One Bob window **and** one worker per worktree on a **single shared board**, partitioned by a
per-task worktree pin and a per-worktree worker lease. Runbook: [README → Worktrees](README.md#worktrees-run-n-in-parallel).

- **Per-instance IPC pipes**, keyed off the worktree path (`tools/print-pipe-name.mjs`, the single
  source of truth) so concurrent Bob windows don't cross-fire over one global pipe.
- **`launch-bob.cmd <worktree-path>`** — launches a Bob bound to one workspace on its own pipe +
  `--user-data-dir` (two Electron instances coexist), seeds auto-approve, and scaffolds
  `bobTasks.pipe` into the worktree's `.vscode/settings.json`.
- **`BOB_TASKS_WORKTREE_SHARED=1`** — every linked worktree resolves the **main** worktree's
  `data/tasks.db` (a no-op for non-worktree dirs); inserted in `defaultDbPath()` after the explicit
  `BOB_TASKS_DB`/`BOB_TASKS_PORTABLE`, before `CLAUDE_PROJECT_DIR`.
- **Worktree pin** — tag a task `worktree:<name>`; the one exact-match tag filter shared by the
  worker's `pickEligible`, `nextTask`, and `get_next_task` routes it end-to-end. Startup reclaim is
  tag-scoped, so workers can share the default `bob` assignee.
- **Worktree lease** — `worker_heartbeats.worktree`; `claimWorktreeLease()` does an atomic
  check-and-claim in one `BEGIN IMMEDIATE` (no two-starts race), refuses a 2nd worker on a live
  checkout, and reclaims a provably-dead one after the heartbeat window. Surfaced as
  `board_status.worker_leases`.
- **Layer-2 mismatch guard** — the worker refuses with a loud `needs_input` when Bob's open folder
  doesn't match the board's worktree, instead of silently editing the wrong tree.

### Compatibility (1.x vs 2.x)

- This is the **last release for IBM Bob 1.x.** Worktree parallelism — and the whole dispatch path —
  ride Bob's `node-ipc` named pipe (`ROO_CODE_IPC_SOCKET_PATH`), which **IBM Bob 2.0 removes.**
- **Plugin 2.0** will target Bob 2.0 with an **in-process driver**: the companion VS Code extension
  calls Bob's exported API (`startTask`) directly and routes per window natively, so the 1.x
  per-instance pipe routing and the bundle patch are **superseded, not carried forward.** The
  shared-board layer (resolver, worktree pin, lease) carries forward unchanged.

### Notes

- The layer-2 wrong-Bob guard stays **inert until `node tools/patch-bob-buttons.mjs` is re-run**
  against your installed Bob bundle (it injects the `GetWorkspace` IPC command) and Bob is
  restarted. It degrades safely without the patch: `queryWorkspace` returns null → "unverifiable"
  → the worker proceeds.

## [1.0.0]

- Initial release: MCP server + CLI + auto-dispatch worker over a SQLite task board; IPC dispatch to
  IBM Bob; mode routing, command/risk gating, ask/answer round-trip, LLM-judge verify-and-continue,
  checkpoint/idle/budget resilience guards, and the `bob-companion` Claude Code plugin.
