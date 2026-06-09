import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTaskScope, SINGLE_DISPATCH_BUDGET } from "./scope.js";

test("a small task is well under the single-dispatch budget and not oversized", () => {
  const s = estimateTaskScope({ title: "Fix a typo in the README" });
  assert.equal(s.oversized, false);
  assert.ok(s.tokens < SINGLE_DISPATCH_BUDGET);
  assert.equal(s.fileCount, 0);
});

test("counts distinct named files and scales the estimate by them", () => {
  const s = estimateTaskScope({
    title: "Refactor auth",
    description: "Update src/auth.ts, src/login.ts, src/session.ts and src/auth.ts again.",
  });
  assert.equal(s.fileCount, 3, "src/auth.ts counted once despite two mentions");
  const fewer = estimateTaskScope({ title: "Refactor auth", description: "Update src/auth.ts only." });
  assert.ok(s.tokens > fewer.tokens, "more files → larger estimate");
});

test("a many-file task crosses the budget and is flagged oversized", () => {
  const s = estimateTaskScope({
    title: "Sweeping change",
    description: "Edit a.ts, b.ts, c.ts, d.ts, e.ts and wire them together with tests.",
  });
  assert.equal(s.oversized, true);
  assert.ok(s.tokens > SINGLE_DISPATCH_BUDGET);
});

test("a long detailed spec raises the estimate (monotonic in description length)", () => {
  const short = estimateTaskScope({ title: "T", description: "Do the thing." });
  const long = estimateTaskScope({ title: "T", description: "Do the thing. ".repeat(400) });
  assert.ok(long.tokens > short.tokens);
  assert.equal(long.oversized, true, "a very long spec alone can exceed the budget");
});

test("read-only modes scale the estimate down vs a write mode", () => {
  const desc = "Look at a.ts, b.ts, c.ts, d.ts, e.ts.";
  const code = estimateTaskScope({ title: "T", description: desc, mode: "code" });
  const ask = estimateTaskScope({ title: "T", description: desc, mode: "ask" });
  assert.ok(ask.tokens < code.tokens, "ask mode estimated smaller than code mode");
});

test("respects a custom budget", () => {
  const s = estimateTaskScope({ title: "Edit a.ts" }, 1_000);
  assert.equal(s.budget, 1_000);
  assert.equal(s.oversized, true, "tiny budget makes even a one-file task oversized");
});
