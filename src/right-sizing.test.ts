import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, createTask } from "./db.js";

// createTask runs the scope estimate (scope.ts) at the board chokepoint: it stamps estimated_tokens
// on every task and, for an oversized one, tags it 'too-big' and routes an implementation task to
// orchestrator — except when staged (curator decides on release) or when a mode was set explicitly.
describe("createTask right-sizing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bob-rightsize-"));
  const big = "Edit a.ts, b.ts, c.ts, d.ts, e.ts and wire them together with tests.";
  before(() => {
    process.env.BOB_TASKS_DB = join(dir, "tasks.db");
    getDb();
  });
  after(() => {
    delete process.env.BOB_TASKS_DB;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("stamps a positive estimated_tokens on every task", () => {
    const t = createTask({ title: "small typo fix" });
    assert.ok(typeof t.estimated_tokens === "number" && (t.estimated_tokens ?? 0) > 0);
    assert.equal(t.tags.includes("too-big"), false, "a small task is not flagged");
  });

  it("routes an oversized implementation task (no mode) to orchestrator + tags too-big", () => {
    const t = createTask({ title: "Implement the feature", description: big });
    assert.equal(t.mode, "orchestrator");
    assert.ok(t.tags.includes("too-big"));
    assert.ok((t.estimated_tokens ?? 0) > 40_000);
  });

  it("does NOT reroute a STAGED oversized task (flags it for the curator instead)", () => {
    const t = createTask({ title: "Implement the staged feature", description: big, staged: true });
    assert.equal(t.mode, null, "staged task keeps its auto-route mode");
    assert.ok(t.tags.includes("too-big"), "still flagged");
    assert.equal(t.status, "staged");
  });

  it("never overrides an explicit mode", () => {
    const t = createTask({ title: "Implement it", description: big, mode: "code" });
    assert.equal(t.mode, "code");
    assert.ok(t.tags.includes("too-big"));
  });

  it("flags but does not route a non-implementation oversized task to orchestrator", () => {
    const t = createTask({
      title: "Explain the architecture",
      description: "Describe a.ts, b.ts, c.ts, d.ts, e.ts and how they interact in detail.",
    });
    assert.notEqual(t.mode, "orchestrator");
    assert.ok(t.tags.includes("too-big"));
  });

  it("respects an explicit estimated_tokens override", () => {
    const t = createTask({ title: "tiny", estimated_tokens: 123 });
    assert.equal(t.estimated_tokens, 123);
  });
});
