# Working in this repo with Claude Code

Bob Control is an MCP server + CLI + auto-dispatch worker over a SQLite
task board (`data/tasks.db`). Bob runs on native Windows and holds the board open in WAL.

## Two execution contexts

Claude Code here runs in one of two contexts. Detect which by `uname` / whether `wslpath`
exists, and use the matching commands.

### WSL inside Bob (common case)

The board is held open in WAL by Bob on the Windows side. WAL's shared memory can't cross
the WSL/Windows boundary, so **opening the board with Linux-side `node` fails with
`disk I/O error 4618`** — even a read. Don't try to fix that by changing the journal mode;
it can't be converted while Bob holds it, and WAL is correct for Bob.

Instead, reach the board through **Windows `node.exe`** (available via WSL interop):

- Board ops: `./bob <create|list|show|...>` — the shim routes the CLI through `node.exe`.
- Make Bob execute a queued task (dispatch over Bob's IPC pipe, which only a Windows-side
  process can reach): `node.exe "$(wslpath -w dist/worker.js)" --once`.
- Build (plain file I/O, runs fine under Linux node): `npm run build`.

### Native Windows

No boundary, so the plain scripts work directly: `node dist/cli.js ...`, `npm run worker`,
`npm run build`. The `./bob` shim also works here (it falls back to plain `node`).

## Quality gate

Before pushing or opening a PR, run the same checks CI enforces and make sure they're green:

```
npm run lint && npm run format:check && npm test
```

(`npm run format` auto-fixes formatting.) CI runs lint → format:check → build → test+coverage on
Windows for Node 22 and 24; a red check blocks the merge.

## Worktrees (run several in parallel)

Several worktrees of this repo can run in parallel on **one shared board**: one Bob window + one
worker per worktree, each pinned `--tag worktree:<name>`, board shared via `BOB_TASKS_WORKTREE_SHARED=1`.
Launch a per-worktree Bob with `launch-bob.cmd <worktree-path>`; a per-worktree lease keeps one worker
per checkout. Full runbook (and the Bob-1.x-only caveat): [README → Worktrees](README.md#worktrees-run-n-in-parallel).

## Notes

- The board is a pull queue: creating a task does not start Bob. Bob runs it when its
  worker pulls, or when you dispatch via the worker above.
