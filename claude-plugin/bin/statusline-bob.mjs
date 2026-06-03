#!/usr/bin/env node
// statusline-bob.mjs — a Claude Code `statusLine` command that appends a live
// summary of IBM Bob's task board (running + queued) to a compact base segment.
//
// This is the plugin-shipped version. It tracks a PER-SESSION board: the current
// project's own data/tasks.db — the same board the plugin's MCP server uses
// (BOB_TASKS_DB=${CLAUDE_PROJECT_DIR}/data/tasks.db) and that project's .bob/mcp.json —
// so each open project shows only its own queue. If the project has no board, it
// falls back to the shared portable board so it still works from a bare repo.
//
// Wire it with the `/bob-statusline` command (writes the snippet into your
// ~/.claude/settings.json for you), or by hand:
//   "statusLine": {
//     "type": "command",
//     "command": "node \"<ABS>/bin/statusline-bob.mjs\""
//   }
//
// Board path resolution (first wins):
//   1. argv[2]                 — explicit path (cross-platform, unlike an inline env
//                                var which Windows `cmd` won't honor).
//   2. $BOB_TASKS_DB           — explicit path via env.
//   3. <project>/data/tasks.db — the current session's project board, if it exists
//                                (project dir comes from the session JSON on stdin).
//   4. ~/.bob-tasks/tasks.db   — the shared portable board (fallback).
//
// Claude Code pipes session JSON on stdin (model, workspace, …) and renders the
// command's first stdout line. The board is read with a plain SELECT (NO migrate /
// NO WAL-init writes) and only if the file exists, so it's cheap to run on every
// render and never mutates or blocks Bob's queue. Any error degrades to the base
// segment. The board must be reached from the Windows side (WAL shared memory can't
// cross the WSL/Windows boundary — see CLAUDE.md / memory wsl-sqlite-wal-gotcha).

// Suppress ONLY the node:sqlite experimental warning (emitted at module load),
// mirroring src/suppress-warnings.ts. Must run before node:sqlite is imported.
const _emit = process.emitWarning.bind(process);
process.emitWarning = (w, ...a) => {
  const m = typeof w === "string" ? w : (w && w.message) || "";
  if (m.includes("SQLite is an experimental feature")) return;
  return _emit(w, ...a);
};

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";

function dbPath(projectDir) {
  if (process.argv[2]) return resolve(process.argv[2]); // explicit path wins
  if (process.env.BOB_TASKS_DB) return resolve(process.env.BOB_TASKS_DB);
  // Per-session: the current project's own board, if it has one.
  if (projectDir) {
    const local = resolve(projectDir, "data", "tasks.db");
    if (existsSync(local)) return local;
  }
  return resolve(homedir(), ".bob-tasks", "tasks.db"); // shared fallback
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function short(title, n = 28) {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

const raw = await readStdin().catch(() => "");
let session = {};
try {
  session = raw ? JSON.parse(raw) : {};
} catch {
  /* not JSON — ignore */
}

// Base segment: "<model> · <dir>" (fields per Claude Code's statusLine schema).
const model = session?.model?.display_name ?? session?.model?.id ?? "";
const cwd = session?.workspace?.current_dir ?? session?.cwd ?? process.cwd();
const base = [model, basename(cwd)].filter(Boolean).join(" · ");

// Bob segment: a single read-only SELECT against the board.
let bob = "";
try {
  const path = dbPath(session?.workspace?.project_dir ?? cwd);
  if (existsSync(path)) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    // Connection-local; does not write the db file. Retries a transient lock
    // instead of throwing while Bob holds the board.
    db.exec("PRAGMA busy_timeout = 2000;");
    const rows = db
      .prepare("SELECT id, title, status FROM tasks WHERE status IN ('in_progress','pending')")
      .all();
    db.close();
    const running = rows.filter((r) => r.status === "in_progress");
    const queued = rows.length - running.length;
    if (running.length) {
      const shown = running.slice(0, 2).map((r) => `#${r.id} ${short(r.title)}`).join(" · ");
      const more = running.length > 2 ? ` +${running.length - 2}` : "";
      const q = queued ? ` (${queued} queued)` : "";
      bob = `⚡ Bob: ${running.length} running${q} · ${shown}${more}`;
    } else if (queued) {
      bob = `· Bob: ${queued} queued`;
    }
  }
} catch {
  /* board missing / locked past the timeout — show the base segment only */
}

process.stdout.write([base, bob].filter(Boolean).join("  |  "));
