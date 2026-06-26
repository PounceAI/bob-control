# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [2.0.1] — 2026-06-26 — Bob 2.0 liveness + routing single-source

Makes the board honest about the Bob 2.0 in-process loop, recovers tasks it strands on a crash, and
collapses the dispatcher's keyword table to one source. No change to dispatch behavior itself.

### Fixed

- **`worker_draining` now reflects the 2.0 in-process loop.** The loop never emitted a heartbeat, so
  `board_status.worker_draining` read `false` — and the skills told you to "start a worker" — even while it
  was actively draining. It now beats like the 1.x worker: `draining` is true whenever the loop runs.
- **Stale `in_progress` recovery on 2.0.** A hard-killed window left its in-flight task stranded
  `in_progress` forever; the loop now reclaims at startup (like the 1.x worker), guarded by a live-peer
  check so it can't re-queue a co-running drainer's task on a shared board.
- **Heartbeat can't leak.** The loop's teardown moved into a step-isolated `try/finally`, so a throw can't
  orphan the interval and pin `worker_draining` true forever.

### Added

- **`predict_mode` MCP tool** — previews a task's routed mode / source / risk straight from the dispatcher's
  router (`modes.ts`). The foreman docs (`/bob-route`, `/bob-next`, `/bob-new`, bob-foreman) now call it
  instead of hand-copying the keyword table (which had silently drifted); a parity test guards re-encoding.
- **`worker_draining.tags`** — each live worker's `--tag` pin (null = unfiltered), so `board_status` shows
  why a live worker isn't pulling a given task (tag mismatch).

### Internal

- The heartbeat protocol is now one shared `startHeartbeat()` helper used by both the 1.x worker and the
  2.0 loop.
- Plugin docs reconciled with 2.0: transport-aware "start a drainer" guidance, and `needs_input` notes that
  a 2.0 in-process Bob has no board reply channel.

## [2.0.0] — 2026-06-26 — IBM Bob 2.0 support (in-process driver)

The companion extension now **auto-detects Bob 1.x vs 2.0** and drives each natively from one build.
IBM Bob 2.0 removed the `node-ipc` pipe that all of 1.x dispatch rode; on 2.0 the extension runs the
board-drain loop **in-process** and calls Bob's exported `startTask` API. The board, CLI, MCP tools,
modes, gating, and verification are unchanged — only the Bob transport is new.

### Added — Bob 2.0 in-process driver

- **In-process dispatch.** A new `InProcessDriver` calls `getExtension('IBM.bob-code').exports.startTask`
  from the extension host (the only place 2.0 is reachable). No child worker, no pipe.
- **Completion via the task store.** `startTask` returns no id and emits no events, so completion is
  observed by snapshotting `~/.bob/db/bob.db`, correlating our new root by `created_at` + content, and
  polling its `active→running→active` lifecycle to a quiet settle; result text + token costs are read
  back from the `messages`/`costs` columns.
- **Config-based auto-approve**, gated + surfaced. `bobTasks.autoApproveGlobal` (default on) writes the
  headless approval into `~/.bob/settings/settings.json`; the first write shows a one-time notice,
  because it's a user-global, persistent change that disables Bob's command security across every window.
- **Carried over to 2.0:** defer-while-chatting (re-derived from a bob.db poll), verify-and-continue
  (command-verify + plan-stop + the LLM judge), and the `worktree:<name>` tag pin + shared board.
- **Worktrees on 2.0 are simpler** — no per-instance pipe plumbing; each window's in-process loop
  dispatches into its own workspace. See [README → Worktrees](README.md#worktrees-run-n-in-parallel).

### Not supported on Bob 2.0 (no IPC reply channel)

Followup auto-answer, dynamic command-classifier approval, and cancel all relied on the inbound IPC
channel 2.0 removed; they remain **Bob 1.x only**. A queued task that hits an `ask_followup_question`
waits for you in Bob's chat. The related settings (`commandClassifier`, `answerFollowups`,
`escalateAll`, `reviewPlans`, `pipe`) are inert on a 2.0 window.

### Hardened (DevSecOps review)

- **TOCTOU (CWE-377):** the settings write uses a random temp-file name, not a predictable `.tmp`, so a
  same-user process can't pre-place a symlink to redirect it.
- **Cross-window task confusion (CWE-284):** correlation requires our **full** prompt to appear in a
  row's `first_message` (was a 120-char prefix), so a foreign task on the shared bob.db can't be
  mistaken for ours.
- **Log injection (CWE-117):** the URI handler strips control chars before logging.

### Compatibility

- **One build, both Bobs.** The extension detects the running Bob and selects the transport; no separate
  download. **Bob 2.0** is the default (in-process); **Bob 1.x** uses the legacy pipe path.
- Staying on **Bob 1.x** and want the last pipe-only build? `v1.1.0` stays published on
  [Releases](https://github.com/PounceAI/bob-control/releases) with its VSIX attached.

## [1.1.0] — 2026-06-25

The **last Bob-1.x-only release** — see [Compatibility](#compatibility-1x-vs-2x) below.

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

- This was the **last release for IBM Bob 1.x only.** Worktree parallelism — and the whole 1.x
  dispatch path — ride Bob's `node-ipc` named pipe (`ROO_CODE_IPC_SOCKET_PATH`), which **IBM Bob 2.0
  removes.**
- **Bob 2.0** is now supported by the same extension via an **in-process driver** (see the 2.0.0
  entry above): it calls Bob's exported `startTask` API directly and routes per window natively, so the
  1.x per-instance pipe routing and the bundle patch are **superseded, not carried forward.** The
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
