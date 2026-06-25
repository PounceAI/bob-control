#!/usr/bin/env node
// print-pipe-name.mjs — prints the per-instance Bob IPC pipe name (or, with --slug, just the slug) for a
// workspace path, so the launcher .cmd scripts don't re-implement the rule (it lives only in
// src/pipe-name.ts → dist/pipe-name.js).
//   node tools/print-pipe-name.mjs <absoluteWorkspacePath> [--slug]
import { bobPipeName } from "../dist/pipe-name.js";

const args = process.argv.slice(2);
const wantSlug = args.includes("--slug");
const workspace = args.find((a) => a !== "--slug");
if (!workspace) {
  console.error("usage: node tools/print-pipe-name.mjs <absoluteWorkspacePath> [--slug]");
  process.exit(1);
}
const name = bobPipeName(workspace);
if (wantSlug) {
  const slug = name.replace(/^\\\\\.\\pipe\\bob-ipc-/, "");
  // Fail loud if the prefix drifts from pipe-name.ts (else the full pipe name poisons the caller's path).
  if (slug === name) {
    console.error("print-pipe-name: pipe name format changed; --slug could not strip the prefix");
    process.exit(1);
  }
  console.log(slug);
} else {
  console.log(name);
}
