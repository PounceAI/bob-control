import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Routing single-source guard. The dispatcher's keyword router lives in ONE place — src/modes.ts,
// surfaced to the plugin through the `predict_mode` MCP tool. The foreman/preview docs must READ the
// routed mode from that tool, never hand-copy the keyword table — copies silently drifted before (bare
// "fetch" vs "fetch the", a missing "mcp tool" / "several steps", an abbreviated ask list). So this test
// asserts each routing doc defers to predict_mode instead of re-encoding the rules.

const moduleDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(moduleDir, "..", "claude-plugin");

// Docs that surface a routed mode to the user. Each must call predict_mode (the single source) rather
// than enumerate the keyword table. (bob-board/bob-triage/bob-work don't route — excluded.)
const ROUTING_DOCS = ["commands/bob-new.md", "commands/bob-route.md", "commands/bob-next.md", "agents/bob-foreman.md"];

// Distinctive multi-word phrases from the router's RULES (modes.ts) that appear there and essentially
// nowhere else in prose. A re-pasted keyword table drags them back in; the trimmed docs contain none.
// Two or more present → the table crept back. (Mentioning predict_mode alone is too weak a guard — every
// routing doc names it in `allowed-tools` frontmatter, so it can't distinguish "defers" from "also copies".)
const TABLE_SIGNATURE = ["fetch the", "several steps", "mcp tool", "rollout"];

for (const file of ROUTING_DOCS) {
  test(`${file} routes via predict_mode, not a hand-copied keyword table`, () => {
    const text = readFileSync(resolve(pluginDir, file), "utf8").toLowerCase();
    assert.ok(
      text.includes("predict_mode"),
      `${file} must read the routed mode from predict_mode (the single source), not re-encode modes.ts`,
    );
    const reencoded = TABLE_SIGNATURE.filter((kw) => text.includes(kw));
    assert.ok(
      reencoded.length < 2,
      `${file} appears to re-encode the dispatcher keyword table (found: ${reencoded.join(", ")}) — route via predict_mode instead`,
    );
  });
}
