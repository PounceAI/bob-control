import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, profileFor, RISK_RANK } from "./modes.js";

// The dispatcher's routing is the source of truth for "what mode Bob runs a task
// in". These tests pin that behavior; the plugin command docs must match it
// (see modes-doc-parity.test.ts).

type T = Parameters<typeof resolveMode>[0];
const task = (over: Partial<T> = {}): T => ({ mode: null, title: "", description: null, tags: [], ...over });
const routeOf = (over: Partial<T>) => resolveMode(task(over));

test("explicit mode wins over everything", () => {
  // An explicit mode beats keywords that would otherwise route elsewhere.
  const r = routeOf({ mode: "code", title: "explain and scrape the website" });
  assert.deepEqual(r, { mode: "code", source: "explicit" });
  // Custom (non-built-in) slug is honored verbatim.
  assert.deepEqual(routeOf({ mode: "my-custom" }), { mode: "my-custom", source: "explicit" });
});

test("a tag naming a built-in mode routes by tag (case-insensitive)", () => {
  assert.deepEqual(routeOf({ tags: ["ASK"], title: "fix the parser" }), { mode: "ask", source: "tag" });
  assert.deepEqual(routeOf({ tags: ["rpg", "advanced"] }), { mode: "advanced", source: "tag" });
});

test("auto-router: advanced keywords", () => {
  for (const title of [
    "scrape the website",
    "take a screenshot of the page",
    "navigate to the url",
    "call the http endpoint",
    "use the mcp tool",
    "crawl the site",
  ]) {
    assert.equal(routeOf({ title }).mode, "advanced", title);
  }
});

test("auto-router: 'fetch the' triggers advanced but bare 'fetch' does not", () => {
  // This is the exact drift point the plugin docs got wrong.
  assert.equal(routeOf({ title: "fetch the latest report" }).mode, "advanced");
  assert.equal(routeOf({ title: "fetch data from db2" }).mode, "code"); // no 'fetch the', no other kw
});

test("auto-router: both http and https route to advanced", () => {
  assert.equal(routeOf({ title: "call the http endpoint" }).mode, "advanced");
  assert.equal(routeOf({ title: "audit https://example.com" }).mode, "advanced");
});

test("auto-router: orchestrator keywords (incl. 'several steps')", () => {
  for (const title of [
    "orchestrate the migration",
    "coordinate the rollout",
    "break this down into sub-tasks",
    "a multi-step workflow",
    "this epic needs planning",
    "several steps are required",
  ]) {
    assert.equal(routeOf({ title }).mode, "orchestrator", title);
  }
});

test("auto-router: ask keywords", () => {
  for (const title of [
    "explain the IPC envelope",
    "document the API",
    "update the docs",
    "what are the tradeoffs",
    "how do I configure it",
    "why is this slow",
    "clarify the requirements",
    "review the approach",
    "help me understand the flow",
  ]) {
    assert.equal(routeOf({ title }).mode, "ask", title);
  }
});

test("auto-router precedence: advanced > orchestrator > ask", () => {
  assert.equal(routeOf({ title: "explain how to scrape the website" }).mode, "advanced");
  assert.equal(routeOf({ title: "coordinate the research effort" }).mode, "orchestrator");
});

test("default is code when nothing matches", () => {
  assert.equal(routeOf({ title: "fix the bug in db.ts" }).source, "default");
  assert.equal(routeOf({ title: "add a stats command", tags: ["cli"] }).mode, "code");
});

test("risk profiles gate the worker correctly", () => {
  assert.equal(profileFor("ask").risk, "safe");
  assert.equal(profileFor("code").risk, "standard");
  assert.equal(profileFor("orchestrator").risk, "standard");
  assert.equal(profileFor("advanced").risk, "elevated");
  assert.equal(profileFor("unknown-slug").risk, "standard"); // default
  assert.ok(RISK_RANK.safe < RISK_RANK.standard && RISK_RANK.standard < RISK_RANK.elevated);
});

test("autoApprove profiles: ask is read-only, advanced enables browser", () => {
  const ask = profileFor("ask").autoApprove;
  assert.equal(ask.alwaysAllowWrite, false);
  assert.equal(ask.alwaysAllowExecute, false);
  assert.equal(ask.alwaysAllowBrowser, false);
  assert.equal(ask.alwaysAllowReadOnly, true);
  assert.equal(profileFor("advanced").autoApprove.alwaysAllowBrowser, true);
});
