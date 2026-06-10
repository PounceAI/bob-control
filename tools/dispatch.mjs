#!/usr/bin/env node
// dispatch.mjs — one-command "create a task, send it to Bob, print the result".
//
// This is the minimal-effort wrapper: it creates a task (optionally from a
// template), runs the worker once scoped to JUST that task (via a unique tag),
// waits for Bob to finish, then prints the captured result. It deliberately
// does NOT pass --emit-json (that flag's stdin-death guard kills the worker
// mid-dispatch when run from a non-interactive shell).
//
// Usage:
//   node tools/dispatch.mjs "Subject line"                       (auto-routed mode)
//   node tools/dispatch.mjs --template code-review "src/foo.ts"
//   node tools/dispatch.mjs --mode code "Add a --json flag to the CLI"
// Options: --template <name> --mode <slug> --priority <p> --max-risk <r>
//          --timeout <ms> --desc <text> --keep (don't print the full task json)
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "dist", "cli.js");
const worker = path.join(root, "dist", "worker.js");
const node = process.execPath;

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const subject = positional[0];
if (!subject) {
  console.error('usage: node tools/dispatch.mjs [--template <name>] [--mode <slug>] "subject"');
  process.exit(1);
}

const tag = `auto-${Date.now().toString(36)}`;
const run = (args, label) => {
  const r = spawnSync(node, args, { cwd: root, encoding: "utf8" });
  if (r.stderr && r.stderr.trim()) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`dispatch: ${label} failed (exit ${r.status})`);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.status ?? 1);
  }
  return r.stdout ?? "";
};

// 1. create the task with our unique scoping tag
const createArgs = [cli, "create", subject, "--tags", tag];
if (opt("--template")) createArgs.push("--template", opt("--template"));
if (opt("--mode")) createArgs.push("--mode", opt("--mode"));
if (opt("--priority")) createArgs.push("--priority", opt("--priority"));
if (opt("--desc")) createArgs.push("--desc", opt("--desc"));
const created = run(createArgs, "create");
process.stdout.write(created);
const id = created.match(/#(\d+)/)?.[1];
if (!id) { console.error("dispatch: could not parse new task id"); process.exit(1); }

// 2. dispatch JUST this task to Bob (scoped by tag; no --emit-json)
console.log(`\n— dispatching #${id} to Bob (tag ${tag}) —`);
const workerArgs = [
  worker, "--once", "--tag", tag,
  "--max-risk", opt("--max-risk") ?? "standard",
  // Sidebar surface (no --new-tab): the quiet, focus-preserving path, and the one
  // the command classifier presses reliably (see tools/patch-bob-buttons.mjs).
  // --new-tab steals focus and is the less-tested approval surface.
  "--no-defer",
  "--timeout", opt("--timeout") ?? "300000",
];
process.stdout.write(run(workerArgs, "worker"));

// 3. show the captured result
console.log(`\n— result for #${id} —`);
process.stdout.write(run([cli, "show", id], "show"));
