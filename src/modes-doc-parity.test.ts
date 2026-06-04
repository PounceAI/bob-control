import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The plugin's foreman/worker commands tell Claude how the dispatcher routes, so
// the foreman's prediction matches the mode Bob actually gets. They must stay in
// sync with src/modes.ts. This test fails if a command file drops a keyword the
// real router uses — the drift that previously made bob-new/next/foreman wrong
// (bare "fetch" instead of "fetch the", missing "mcp tool" / "several steps", and
// an abbreviated ask list).

const moduleDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(moduleDir, "..", "claude-plugin");

// Keywords the dispatcher (modes.ts RULES) keys on that have been dropped or
// mis-stated in docs before. Any command that documents the keyword router must
// mention all of these verbatim.
const REQUIRED = [
  "review the diff", // review
  "rollout", // plan
  "security scan", // devsecops
  "vulnerability", // devsecops
  "mcp tool", // advanced
  "fetch the", // advanced (NOT bare "fetch")
  "several steps", // orchestrator
  "clarify", // ask
  "understand", // ask
  "what are", // ask
  "how do", // ask
  "why does", // ask
  "why is", // ask
];

// Files that enumerate the keyword router, with their path under claude-plugin/.
// (bob-board/bob-triage/bob-work don't list keywords — bob-work defers to
// /bob-route — so they're excluded.)
const ROUTING_DOCS = ["commands/bob-new.md", "commands/bob-route.md", "commands/bob-next.md", "agents/bob-foreman.md"];

for (const file of ROUTING_DOCS) {
  test(`${file} documents the full dispatcher keyword set`, () => {
    const text = readFileSync(resolve(pluginDir, file), "utf8").toLowerCase();
    const missing = REQUIRED.filter((kw) => !text.includes(kw));
    assert.deepEqual(missing, [], `${file} is missing dispatcher keywords: ${missing.join(", ")}`);
  });
}
