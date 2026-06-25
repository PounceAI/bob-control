// set-bob-autoapprove.mjs
// Enables Bob (Roo Code fork) auto-approval so it can run tasks driven over IPC
// without stalling on manual approval prompts (taskInteractive -> abort).
//
// MUST be run while the TARGET instance is FULLY CLOSED. Writing to a live VS Code state.vscdb
// can corrupt it, and Bob will flush its in-memory copy over the edit on exit.
// Invoked from launch-bob-ipc.cmd / launch-bob.cmd right before launching Bob.
//
// --user-data-dir <dir>: target a per-instance Bob (launch-bob.cmd). If that instance's DB doesn't
// exist yet, it's SEEDED from the default instance's DB first (safe: a never-launched instance).
//
// Idempotent: safe to run repeatedly. Backs up the DB once to
// state.vscdb.autoapprove.bak before the first write.

import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Same allowlist the worker sends per-dispatch, so global state can't drift from it.
import { SAFE_COMMANDS } from "./dist/modes.js";

const APPDATA = process.env.APPDATA;
if (!APPDATA) {
  console.error(
    "[set-autoapprove] %APPDATA% is not set — run from a normal Windows session."
  );
  process.exit(1);
}
// --user-data-dir <dir> targets a specific instance's settings DB (a per-workspace Bob from
// launch-bob.cmd); omitted = the default instance under %APPDATA%\IBM Bob.
const udiArg = process.argv.indexOf("--user-data-dir");
const userDataDir = udiArg !== -1 ? process.argv[udiArg + 1] : null;
// A present-but-missing/flag-looking value must NOT silently fall back to the default DB (that would
// reconfigure the wrong instance) — fail loudly. `null` (flag absent) is the legitimate default case.
if (udiArg !== -1 && (!userDataDir || userDataDir.startsWith("--"))) {
  console.error("[set-autoapprove] --user-data-dir requires a directory path.");
  process.exit(1);
}
const defaultDb = `${APPDATA.replace(/\\/g, "/")}/IBM Bob/User/globalStorage/state.vscdb`;
const DB = userDataDir
  ? `${userDataDir.replace(/\\/g, "/").replace(/\/+$/, "")}/User/globalStorage/state.vscdb`
  : defaultDb;

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

// Seed a fresh per-instance DB from the default so a new instance inherits the Roo schema + settings
// (auto-approve re-applied below). Only when the custom dir's DB doesn't exist yet — never launched, so
// writing it can't corrupt a live DB, and the running-Bob guard is moot.
let seeded = false;
if (userDataDir && !existsSync(DB)) {
  if (!existsSync(defaultDb)) {
    console.error(
      `[set-autoapprove] no default instance DB to seed from at:\n  ${defaultDb}\n` +
        "  Launch the default Bob once (so its settings exist), then retry."
    );
    process.exit(1);
  }
  try {
    mkdirSync(dirname(DB), { recursive: true });
    // VACUUM INTO takes a CONSISTENT snapshot of the (possibly live, WAL-mode) default DB — a raw file
    // copy can be torn mid-write and misses the -wal sidecar while the default Bob is running.
    const src = new DatabaseSync(defaultDb);
    try {
      src.exec(`VACUUM INTO '${DB.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
  } catch (e) {
    console.error(
      `[set-autoapprove] could not snapshot the default DB: ${e.message}\n  Fully quit the default Bob and retry.`
    );
    process.exit(1);
  }
  seeded = true;
  console.log(`[set-autoapprove] seeded a new instance DB from the default:\n  ${DB}`);
}

if (!existsSync(DB)) {
  console.error(`[set-autoapprove] state.vscdb not found at:\n  ${DB}`);
  process.exit(1);
}

// A just-seeded instance has never launched, so it can't be the live Bob — safe to write. Otherwise
// refuse while ANY Bob runs: we can't tell which instance owns this DB, and editing a live one corrupts
// it (Bob flushes its in-memory copy on exit).
if (!seeded && bobRunning()) {
  console.error(
    "[set-autoapprove] REFUSING: 'IBM Bob.exe' is running. Fully quit Bob first " +
      "(editing a live state.vscdb can corrupt it and Bob will overwrite the change on exit)."
  );
  process.exit(1);
}

// Back up the existing DB before editing — but not a freshly-seeded one (it's a fresh snapshot of the
// default with no prior per-instance state to protect).
if (!seeded) {
  const bak = DB + ".autoapprove.bak";
  if (!existsSync(bak)) {
    copyFileSync(DB, bak);
    console.log(`[set-autoapprove] backup created: ${bak}`);
  }
}

let db;
try {
  db = new DatabaseSync(DB);
} catch (e) {
  console.error(`[set-autoapprove] could not open the settings DB (${DB}): ${e.message}`);
  process.exit(1);
}
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
