#!/usr/bin/env node
// scaffold-workspace-settings.mjs <workspace>
// Write bobTasks.pipe (this workspace's per-instance pipe) into <workspace>/.vscode/settings.json so the
// extension-spawned worker routes to THIS Bob without a rebuilt VSIX. .vscode is gitignored and the value
// is machine/path-specific, so it stays local. Merges into plain JSON (BOM-safe); prints for JSONC.
import { bobPipeName } from "../dist/pipe-name.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ws = process.argv[2];
if (!ws) {
  console.error("usage: node tools/scaffold-workspace-settings.mjs <workspace>");
  process.exit(1);
}
const pipe = bobPipeName(ws);
const dir = join(ws, ".vscode");
const file = join(dir, "settings.json");

if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ "bobTasks.pipe": pipe }, null, 2) + "\n");
  console.log(`[scaffold] wrote ${file}  (bobTasks.pipe = ${pipe})`);
} else {
  let parsed = null;
  try {
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip a leading UTF-8 BOM; JSON.parse rejects it
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed["bobTasks.pipe"] === pipe) {
      console.log(`[scaffold] bobTasks.pipe already correct in ${file}`);
    } else {
      parsed["bobTasks.pipe"] = pipe;
      writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
      console.log(`[scaffold] set bobTasks.pipe in ${file}`);
    }
  } else {
    console.log(`[scaffold] ${file} isn't plain JSON — add this yourself:\n  "bobTasks.pipe": ${JSON.stringify(pipe)}`);
  }
}
