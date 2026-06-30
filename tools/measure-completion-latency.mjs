// Read-only probe for the post-completion lag: how long after Bob is visibly done (its bob.db root
// leaves 'running') the board goes terminal and `await_task` unblocks. Watches both stores at 150ms;
// never writes either. Drainer-agnostic — it reports whatever quiet window the live loop runs, so the
// same script measures the old 8s default and the tuned 2s default for a direct before/after.
//
// Usage (from the repo root, with dist/ built):
//   1. node tools/measure-completion-latency.mjs <title>   # run in the BACKGROUND — it snapshots first
//   2. then dispatch a probe with the SAME title to the live drainer's tag, e.g.
//      node dist/cli.js create "<title>" --mode ask --tags <drainer-tag> \
//        --desc "Reply with exactly PROBE-DONE. Do NOT read/modify files or run commands."
//   3. read the SUMMARY: `lag_visible_completion_to_board_terminal` is the headline
//      (~9000ms on quietMs=8000, ~3000ms on quietMs=2000).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { Bob2TaskStore, isActivelyRunning } = await import(pathToFileURL(resolve("dist/bob2-taskstore.js")).href);

const PROBE_TITLE = process.argv[2] ?? "latency-probe";
const POLL_MS = 150;
const TIMEOUT_MS = 220_000;

const tasksDb = new DatabaseSync(resolve("data/tasks.db"), { readOnly: true });
const store = Bob2TaskStore.open();
const snap = store.snapshotRoots();
const t0 = Date.now();
const mark = (label, extra = {}) => {
  const t = Date.now() - t0;
  console.error(`+${String(t).padStart(6)}ms  ${label}${Object.keys(extra).length ? "  " + JSON.stringify(extra) : ""}`);
};
mark("probe-start", { sinceMs: snap.sinceMs, preexistingRoots: snap.ids.size });

const qTask = tasksDb.prepare(`SELECT id, status FROM tasks WHERE title = ? ORDER BY id DESC LIMIT 1`);
const TERMINAL = new Set(["done", "analysis_done", "blocked", "cancelled"]);

let taskId = null;
let rootId = null;
let lastBoard = null;
let lastRootStatus = null;
let lastRootUpdated = null;
let tInProgress = null;
let tRunning = null;
let tRunningEnd = null;
let tLastRootBump = null;
let tBoardTerminal = null;

while (Date.now() - t0 < TIMEOUT_MS) {
  const trow = qTask.get(PROBE_TITLE);
  if (trow) {
    if (taskId === null) {
      taskId = trow.id;
      mark("board:task-seen", { id: taskId, status: trow.status });
    }
    if (trow.status !== lastBoard) {
      mark("board:status", { from: lastBoard, to: trow.status });
      lastBoard = trow.status;
      if (trow.status === "in_progress" && tInProgress === null) tInProgress = Date.now() - t0;
      if (TERMINAL.has(trow.status)) {
        tBoardTerminal = Date.now() - t0;
        mark("board:TERMINAL", { status: trow.status });
        break;
      }
    }
  }
  if (rootId === null) {
    const r = store.newRootSince(snap.ids, snap.sinceMs);
    if (r) {
      rootId = r.id;
      mark("bob:root-appeared", { id: rootId, status: r.status });
    }
  }
  if (rootId) {
    const r = store.read(rootId);
    if (r) {
      if (r.status !== lastRootStatus) {
        mark("bob:status", { from: lastRootStatus, to: r.status });
        if (r.status === "running" && tRunning === null) tRunning = Date.now() - t0;
        if (lastRootStatus && isActivelyRunning(lastRootStatus) && !isActivelyRunning(r.status) && tRunningEnd === null) {
          tRunningEnd = Date.now() - t0;
          mark("bob:RUNNING-END (visible completion)", { to: r.status });
        }
        lastRootStatus = r.status;
      }
      if (r.updated_at !== lastRootUpdated) {
        if (lastRootUpdated !== null) {
          tLastRootBump = Date.now() - t0;
          mark("bob:updated_at-bump");
        }
        lastRootUpdated = r.updated_at;
      }
    }
  }
  await new Promise((res) => setTimeout(res, POLL_MS));
}

const summary = {
  taskId,
  rootId,
  t_in_progress: tInProgress,
  t_running_start: tRunning,
  t_running_end__visible_completion: tRunningEnd,
  t_last_root_bump: tLastRootBump,
  t_board_terminal__await_unblocks: tBoardTerminal,
  // headline: ms from Bob's visible completion to await_task unblocking
  lag_visible_completion_to_board_terminal:
    tRunningEnd != null && tBoardTerminal != null ? tBoardTerminal - tRunningEnd : null,
  // ~= the drainer's quiet window + finalize (settles this long after the last bob.db write)
  settle_after_last_bump: tLastRootBump != null && tBoardTerminal != null ? tBoardTerminal - tLastRootBump : null,
};
console.error("\n===== SUMMARY =====");
console.error(JSON.stringify(summary, null, 2));
store.close();
tasksDb.close();
