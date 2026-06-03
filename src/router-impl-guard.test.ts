import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, looksLikeImplementation, isReadOnlyMode } from "./modes.js";

// Pure router — no DB needed.
describe("router implementation guard (incident C)", () => {
  it("an implementation task is NOT routed to read-only ask, even when it says 'analyze'", () => {
    const r = resolveMode({
      mode: null,
      title: "Minimize PHI exposure in summarizer",
      description: "Analyze where PHI is exposed and minimize it in the embedding pipeline.",
      tags: [],
    });
    assert.equal(r.mode, "code");
  });

  it("a genuine analysis task still routes to ask", () => {
    const r = resolveMode({
      mode: null,
      title: "Analyze the auth flow",
      description: "Explain how login works and document the token lifecycle.",
      tags: [],
    });
    assert.equal(r.mode, "ask");
  });

  it("explicit mode and mode-naming tags still win", () => {
    assert.equal(resolveMode({ mode: "ask", title: "Implement X", description: "", tags: [] }).mode, "ask");
    assert.equal(resolveMode({ mode: null, title: "Implement X", description: "", tags: ["ask"] }).mode, "ask");
  });

  it("looksLikeImplementation detects build verbs but not pure analysis", () => {
    assert.equal(looksLikeImplementation("implement the cache layer"), true);
    assert.equal(looksLikeImplementation("encrypt the tokens at rest"), true);
    assert.equal(looksLikeImplementation("explain how the cache works"), false);
  });

  it("looksLikeImplementation does not match a verb inside a hyphen-compound (value-add)", () => {
    // "value-add" must not count as the verb "add" and yank an analysis task into code mode.
    assert.equal(looksLikeImplementation("Explain the value-add of caching"), false);
    assert.equal(
      resolveMode({ mode: null, title: "Explain the value-add of caching", description: "", tags: [] }).mode,
      "ask",
    );
  });

  it("isReadOnlyMode classifies the read-only modes the done-gate depends on", () => {
    for (const m of ["ask", "plan", "review"]) assert.equal(isReadOnlyMode(m), true, m);
    for (const m of ["code", "refactor", "devsecops", "orchestrator", "advanced"]) {
      assert.equal(isReadOnlyMode(m), false, m);
    }
  });
});
