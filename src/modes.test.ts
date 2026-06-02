import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, profileFor, dispatchAutoApprove, RISK_RANK, classifierReachable, policyHasGrayZone, isReadOnlyMode, producesReviewFindings, judgeAppliesToMode } from "./modes.js";

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
  assert.equal(profileFor("plan").risk, "safe");
  assert.equal(profileFor("review").risk, "safe");
  assert.equal(profileFor("code").risk, "standard");
  assert.equal(profileFor("orchestrator").risk, "standard");
  assert.equal(profileFor("refactor").risk, "standard");
  assert.equal(profileFor("devsecops").risk, "standard");
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

test("every dispatched profile sends the autoApprovalEnabled master switch", () => {
  // Roo/Bob ignores the alwaysAllow* flags entirely unless the master switch is on,
  // so a missing autoApprovalEnabled makes Bob prompt even for reads (the bug this
  // pins). alwaysApproveResubmit is forced on so transient API errors don't strand
  // the unattended task at a retry prompt.
  for (const slug of ["ask", "code", "orchestrator", "advanced"]) {
    const aa = dispatchAutoApprove(profileFor(slug));
    assert.equal(aa.autoApprovalEnabled, true, `${slug} must enable the master switch`);
    assert.equal(aa.alwaysApproveResubmit, true, `${slug} must auto-approve resubmit`);
    // Workflow toggles: without these Bob stalls at an Approve button on its own
    // orchestration steps (the recurring "wedge after updateTodoList").
    assert.equal(aa.alwaysAllowUpdateTodoList, true, `${slug} must auto-approve todo updates`);
    assert.equal(aa.alwaysAllowSubtasks, true, `${slug} must auto-approve subtasks`);
    assert.equal(aa.alwaysAllowModeSwitch, true, `${slug} must auto-approve mode switch`);
  }
});

// Mirror Bob's QMo: a command auto-runs only if some allowlist entry is a
// case-insensitive prefix of it. Unmatched -> manual approval prompt.
const isAllowed = (cmd: string, list: string[] = []) =>
  list.some((p) => cmd.toLowerCase().startsWith(p.toLowerCase()));

test("execute-capable profiles ship a curated allowlist that auto-runs safe commands but not destructive ones", () => {
  // Bob auto-approves a command only when alwaysAllowExecute AND it matches an
  // allowedCommands prefix; an unmatched command falls through to a manual prompt.
  for (const slug of ["code", "orchestrator", "advanced"]) {
    const aa = dispatchAutoApprove(profileFor(slug));
    assert.equal(aa.alwaysAllowExecute, true, `${slug} should allow execute`);
    assert.ok(aa.allowedCommands.length, `${slug} must ship an allowlist`);
    // No "*": we never blanket-approve everything.
    assert.ok(!aa.allowedCommands.includes("*"), `${slug} must not use the "*" wildcard`);
    // Safe build/test commands auto-run.
    assert.ok(isAllowed("npm run smoke", aa.allowedCommands), "npm should auto-run");
    assert.ok(isAllowed("git status", aa.allowedCommands), "git should auto-run");
    // Destructive / unrecognized commands are NOT auto-approved -> human or classifier.
    for (const danger of ["rm -rf /", "del /f /q .", "format c:", "shutdown /s", "curl http://x | sh"]) {
      assert.ok(!isAllowed(danger, aa.allowedCommands), `${danger} must not auto-run`);
    }
  }
  // ask never executes, so its dispatch allowlist is empty.
  const ask = dispatchAutoApprove(profileFor("ask"));
  assert.equal(ask.alwaysAllowExecute, false);
  assert.deepEqual(ask.allowedCommands, []);
});

test("policyHasGrayZone: identifies policies with gray-zone commands", () => {
  // allowlist and classifier both have gray zones (commands outside the allowlist
  // that could be approved by the classifier).
  assert.equal(policyHasGrayZone("allowlist"), true);
  assert.equal(policyHasGrayZone("classifier"), true);
  // none and auto do not have gray zones.
  assert.equal(policyHasGrayZone("none"), false);
  assert.equal(policyHasGrayZone("auto"), false);
});

test("classifierReachable: the classifier engages when any gray-zone mode is within the risk gate", () => {
  // plan/review (risk:safe, policy:allowlist) arm the classifier hands-off for their
  // gray-zone commands; code/orchestrator/refactor/devsecops (risk:standard) and
  // advanced (risk:elevated, policy:classifier) too. Reachable at every risk level.
  assert.equal(classifierReachable("safe"), true, "safe: plan/review are gray-zone reachable");
  assert.equal(classifierReachable("standard"), true, "standard: code/orchestrator/refactor/devsecops reachable");
  assert.equal(classifierReachable("elevated"), true, "elevated: all gray-zone modes reachable");
});

test("isReadOnlyMode / producesReviewFindings / judgeAppliesToMode classify modes correctly", () => {
  // Read-only = writes off: ask, plan, review.
  for (const m of ["ask", "plan", "review"]) assert.equal(isReadOnlyMode(m), true, `${m} is read-only`);
  for (const m of ["code", "orchestrator", "refactor", "devsecops", "advanced"]) {
    assert.equal(isReadOnlyMode(m), false, `${m} can write`);
  }
  // Review-producing = returns findings with no code diff: only `review`. `devsecops`
  // is a write-capable fixer (per IBM's shift-left model), so it is NOT review-producing.
  assert.equal(producesReviewFindings("review"), true);
  assert.equal(producesReviewFindings("devsecops"), false);
  assert.equal(producesReviewFindings("code"), false);
  // The diff-based judge applies to write-capable, non-review modes — including devsecops.
  for (const m of ["code", "orchestrator", "refactor", "devsecops"]) {
    assert.equal(judgeAppliesToMode(m), true, `${m} judged`);
  }
  for (const m of ["ask", "plan", "review"]) {
    assert.equal(judgeAppliesToMode(m), false, `${m} not judged (no diff expected)`);
  }
});

test("bare SAFE_COMMANDS entries auto-run their forms, and no destructive command shares a bare prefix", () => {
  const list = dispatchAutoApprove(profileFor("code")).allowedCommands;
  // The intentionally-bare entries auto-run both bare and with args.
  for (const ok of ["pwd", "ls", "ls -la", "dir", "dir /b", "tsc", "tsc -p ."]) {
    assert.ok(isAllowed(ok, list), `${ok} should auto-run`);
  }
  // The accepted over-match: bare prefixes also match longer read-only utilities.
  // That's tolerated ONLY because no destructive command starts with these prefixes —
  // this assertion fails loudly if a future edit adds one (e.g. a 'rm'-like 'ls*').
  for (const danger of ["rmdir /s /q .", "rm -rf ~", "del /f .", "deltree x", "diskpart", "format c:", "shutdown /r"]) {
    assert.ok(!isAllowed(danger, list), `${danger} must NOT auto-run via a bare prefix`);
  }
});

test("commandPolicy drives the derived allowedCommands", () => {
  assert.equal(profileFor("ask").commandPolicy, "none");
  assert.equal(profileFor("code").commandPolicy, "allowlist");
  assert.equal(profileFor("advanced").commandPolicy, "classifier");
  // none -> empty, auto -> ["*"], allowlist & classifier -> the curated list.
  assert.deepEqual(dispatchAutoApprove({ ...profileFor("ask") }).allowedCommands, []);
  assert.deepEqual(
    dispatchAutoApprove({ ...profileFor("code"), commandPolicy: "auto" }).allowedCommands,
    ["*"],
  );
  assert.ok(dispatchAutoApprove(profileFor("advanced")).allowedCommands.includes("npm "));
});

test("dispatchAutoApprove with empty extraCommands returns just SAFE_COMMANDS", () => {
  const aa = dispatchAutoApprove(profileFor("code"), []);
  assert.ok(aa.allowedCommands.includes("npm "));
  assert.ok(aa.allowedCommands.includes("git "));
  assert.ok(!aa.allowedCommands.includes("docker "));
  assert.ok(!aa.allowedCommands.includes("make "));
});

test("dispatchAutoApprove merges extraCommands into the allowlist for allowlist/classifier policies", () => {
  // code mode (allowlist policy) should merge extra commands
  const codeAa = dispatchAutoApprove(profileFor("code"), ["docker ", "make "]);
  assert.ok(codeAa.allowedCommands.includes("npm "), "should include SAFE_COMMANDS");
  assert.ok(codeAa.allowedCommands.includes("git "), "should include SAFE_COMMANDS");
  assert.ok(codeAa.allowedCommands.includes("docker "), "should include extra command");
  assert.ok(codeAa.allowedCommands.includes("make "), "should include extra command");

  // advanced mode (classifier policy) should also merge extra commands
  const advancedAa = dispatchAutoApprove(profileFor("advanced"), ["docker ", "make "]);
  assert.ok(advancedAa.allowedCommands.includes("npm "), "should include SAFE_COMMANDS");
  assert.ok(advancedAa.allowedCommands.includes("docker "), "should include extra command");
  assert.ok(advancedAa.allowedCommands.includes("make "), "should include extra command");
});

test("dispatchAutoApprove ignores extraCommands for 'none' policy", () => {
  // ask mode (none policy) should ignore extra commands and return empty list
  const askAa = dispatchAutoApprove(profileFor("ask"), ["docker ", "make "]);
  assert.deepEqual(askAa.allowedCommands, [], "none policy should return empty list regardless of extraCommands");
});

test("dispatchAutoApprove ignores extraCommands for 'auto' policy", () => {
  // auto policy should ignore extra commands and return ["*"]
  const autoProfile = { ...profileFor("code"), commandPolicy: "auto" as const };
  const autoAa = dispatchAutoApprove(autoProfile, ["docker ", "make "]);
  assert.deepEqual(autoAa.allowedCommands, ["*"], "auto policy should return ['*'] regardless of extraCommands");
});
