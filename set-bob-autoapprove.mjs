// set-bob-autoapprove.mjs
// Enables Bob (Roo Code fork) auto-approval so it can run tasks driven over IPC
// without stalling on manual approval prompts (taskInteractive -> abort).
//
// MUST be run while Bob is FULLY CLOSED. Writing to a live VS Code state.vscdb
// can corrupt it, and Bob will flush its in-memory copy over the edit on exit.
// Intended to be invoked from launch-bob-ipc.cmd right before launching Bob.
//
// Idempotent: safe to run repeatedly. Backs up the DB once to
// state.vscdb.autoapprove.bak before the first write.

import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
// Same allowlist the worker sends per-dispatch, so global state can't drift from it.
import { SAFE_COMMANDS } from "./dist/modes.js";

const DB =
  "C:/Users/joshu/AppData/Roaming/IBM Bob/User/globalStorage/state.vscdb";

// Roo/Bob globalState keys. Values are stored exactly as VS Code stores them:
// JSON.stringify(value). Booleans -> "true", arrays -> '["npm ", ...]'.
const SETTINGS = {
  autoApprovalEnabled: true,        // master switch for auto-approve
  alwaysAllowMcp: true,             // auto-approve MCP tool calls (bob-tasks)
  alwaysAllowReadOnly: true,        // auto-approve file reads
  alwaysAllowWrite: true,           // auto-approve in-workspace file writes
  alwaysAllowExecute: true,         // auto-approve terminal command execution
  // The curated allowlist, NOT ["*"] — a wildcard would auto-run anything (rm -rf,
  // shutdown) and bypass the gray-zone classifier.
  allowedCommands: SAFE_COMMANDS,
  alwaysApproveResubmit: true,      // auto-retry on transient API errors
};

function bobRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq IBM Bob.exe" /NH', {
      encoding: "utf8",
    });
    return /IBM Bob\.exe/i.test(out);
  } catch {
    return false;
  }
}

if (!existsSync(DB)) {
  console.error(`[set-autoapprove] state.vscdb not found at:\n  ${DB}`);
  process.exit(1);
}

if (bobRunning()) {
  console.error(
    "[set-autoapprove] REFUSING: 'IBM Bob.exe' is running. Fully quit Bob first " +
      "(editing a live state.vscdb can corrupt it and Bob will overwrite the change on exit)."
  );
  process.exit(1);
}

const bak = DB + ".autoapprove.bak";
if (!existsSync(bak)) {
  copyFileSync(DB, bak);
  console.log(`[set-autoapprove] backup created: ${bak}`);
}

const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 4000");
const upsert = db.prepare(
  "INSERT INTO ItemTable(key, value) VALUES(?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

db.exec("BEGIN");
for (const [key, value] of Object.entries(SETTINGS)) {
  upsert.run(key, JSON.stringify(value));
}
db.exec("COMMIT");

// Verify
console.log("[set-autoapprove] applied:");
for (const key of Object.keys(SETTINGS)) {
  const r = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
  console.log(`  ${key} = ${r ? String(r.value) : "(absent!)"}`);
}
db.close();
console.log("[set-autoapprove] done. Launch Bob now.");
