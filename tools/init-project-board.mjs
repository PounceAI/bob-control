#!/usr/bin/env node
// init-project-board.mjs — scaffold a per-project Bob board for another repo.
//
// Per-session boards mean each project Bob opens has its own queue at
// <project>/data/tasks.db. Three of the four consumers resolve that path on their own
// (the plugin MCP via ${CLAUDE_PROJECT_DIR}, the extension worker via the open folder,
// the status line via the session dir). The ONE piece that can't auto-resolve is Bob's
// own MCP config: Bob doesn't expand ${CLAUDE_PROJECT_DIR}, so every project needs its
// own .bob/mcp.json. This drops a correct one in.
//
//   node tools/init-project-board.mjs <project-dir> [--force]
//
// It points the `bob-tasks` server at THIS connector's dist/server.js (shared install),
// sets BOB_TASKS_DB + cwd to <project-dir>, and creates <project-dir>/data/. Existing
// .bob/mcp.json is preserved (other servers kept); pass --force to overwrite an existing
// bob-tasks entry. After running, reload the project's MCP servers in Bob.

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// JSON/Bob paths use forward slashes (matches the connector's own .bob/mcp.json).
const fwd = (p) => p.replace(/\\/g, "/");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const targetArg = argv.find((a) => !a.startsWith("--"));

if (!targetArg) {
  console.error("usage: node tools/init-project-board.mjs <project-dir> [--force]");
  process.exit(1);
}

// The connector install = this script's repo root (tools/..), so server.js resolves
// correctly even after the connector folder is renamed/moved.
const connectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverJs = fwd(join(connectorRoot, "dist", "server.js"));
if (!existsSync(serverJs)) {
  console.error(`No server at ${serverJs} — run 'npm run build' in the connector first.`);
  process.exit(1);
}

const projectDir = resolve(targetArg);
if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
  console.error(`Not a directory: ${projectDir}`);
  process.exit(1);
}

const boardDb = fwd(join(projectDir, "data", "tasks.db"));
const bobDir = join(projectDir, ".bob");
const mcpPath = join(bobDir, "mcp.json");

const entry = {
  type: "stdio",
  command: "node",
  args: [serverJs],
  env: { BOB_TASKS_DB: boardDb },
  cwd: fwd(projectDir),
  timeout: 60,
  disabled: false,
  alwaysAllow: [
    "list_tasks", "get_task", "get_next_task", "claim_task", "update_task_status",
    "add_task_note", "submit_result", "ask_question", "answer_task_question", "await_answer",
    "await_task", "create_task", "set_task_mode", "set_task_dependencies", "delete_task",
    "revert_task", "board_status", "board_report", "record_artifact", "release_tasks",
    "arm_board", "disarm_board",
  ],
  watchPaths: [serverJs],
};

// Merge into an existing config rather than clobbering other servers.
let config = { $schema: "https://bob-code.com/schemas/mcp-config.schema.json", mcpServers: {} };
if (existsSync(mcpPath)) {
  try {
    config = JSON.parse(readFileSync(mcpPath, "utf8"));
    config.mcpServers ??= {};
  } catch (e) {
    console.error(`Existing ${mcpPath} is not valid JSON (${e.message}) — refusing to overwrite. Fix or remove it.`);
    process.exit(1);
  }
  if (config.mcpServers["bob-tasks"] && !force) {
    console.error(`${mcpPath} already has a 'bob-tasks' server. Re-run with --force to overwrite it.`);
    process.exit(1);
  }
}
config.mcpServers["bob-tasks"] = entry;

mkdirSync(bobDir, { recursive: true });
mkdirSync(join(projectDir, "data"), { recursive: true });
writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");

console.log(`✓ wrote ${fwd(mcpPath)}`);
console.log(`  board:  ${boardDb}`);
console.log(`  server: ${serverJs}`);
console.log(`Next: open ${fwd(projectDir)} in Bob and reload MCP servers (MCP panel), then dispatch as usual.`);
