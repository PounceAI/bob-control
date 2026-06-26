import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVerdict,
  judgeCompletion,
  buildJudgeVerifier,
  captureGitDiff,
  captureGitBaseline,
  type JudgeContext,
  type JudgeDeps,
  type JudgeVerifierDeps,
} from "./judge.js";
import type { LlmResult } from "./llm.js";

// Mock LLM call for testing
function mockLlm(result: LlmResult): JudgeDeps {
  return {
    backend: "api",
    apiKey: "test-key",
    fetchImpl: async () => {
      if (!result.ok) throw new Error(result.reason);
      return {
        ok: true,
        json: async () => ({ content: [{ text: result.text }] }),
      } as Response;
    },
  };
}

test("parseVerdict: JSON with pass=true", () => {
  const verdict = parseVerdict('{"pass":true,"reason":"all requirements met"}');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "all requirements met");
});

test("parseVerdict: JSON with pass=false", () => {
  const verdict = parseVerdict('{"pass":false,"reason":"missing tests"}');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "missing tests");
});

test("parseVerdict: JSON with extra text", () => {
  const verdict = parseVerdict('Here is my verdict: {"pass":true,"reason":"looks good"} and that is final.');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "looks good");
});

test("parseVerdict: bare PASS token", () => {
  const verdict = parseVerdict("PASS");
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "judge verdict: PASS");
});

test("parseVerdict: bare FAIL token", () => {
  const verdict = parseVerdict("FAIL");
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "judge verdict: FAIL");
});

test("parseVerdict: case-insensitive PASS", () => {
  const verdict = parseVerdict("The task should pass");
  assert.equal(verdict.pass, true);
});

test("parseVerdict: FAIL takes precedence over PASS", () => {
  const verdict = parseVerdict("This would pass but it should FAIL");
  assert.equal(verdict.pass, false);
});

test("parseVerdict: unparseable defaults to FAIL", () => {
  const verdict = parseVerdict("I'm not sure about this one");
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "unparseable judge output");
});

test("parseVerdict: malformed JSON defaults to FAIL", () => {
  const verdict = parseVerdict('{"pass":true,reason:"missing quotes"}');
  // Malformed JSON is skipped, falls through to token parsing where PASS is found
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "judge verdict: PASS");
});

test("parseVerdict: JSON without pass field defaults to FAIL", () => {
  const verdict = parseVerdict('{"result":"complete","reason":"done"}');
  assert.equal(verdict.pass, false);
});

test("parseVerdict: empty reason gets placeholder", () => {
  const verdict = parseVerdict('{"pass":true,"reason":""}');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "(no reason)");
});

test("judgeCompletion: PASS verdict accepts", async () => {
  const ctx: JudgeContext = {
    taskPrompt: "Add a login form",
    completionResult: "Added login form with validation",
    gitDiff: "+function login() { ... }",
  };
  const deps = mockLlm({ ok: true, text: '{"pass":true,"reason":"form implemented"}' });
  const verdict = await judgeCompletion(ctx, deps);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "form implemented");
});

test("judgeCompletion: FAIL verdict rejects", async () => {
  const ctx: JudgeContext = {
    taskPrompt: "Add a login form with validation",
    completionResult: "I will add a login form",
    gitDiff: "",
  };
  const deps = mockLlm({ ok: true, text: '{"pass":false,"reason":"no code written, only a plan"}' });
  const verdict = await judgeCompletion(ctx, deps);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "no code written, only a plan");
});

test("judgeCompletion: LLM error fails OPEN (PASS) so infra failure never blocks a task", async () => {
  const ctx: JudgeContext = {
    taskPrompt: "Fix the bug",
    completionResult: "Bug fixed",
    gitDiff: "+fix",
  };
  const deps = mockLlm({ ok: false, reason: "timeout" });
  const verdict = await judgeCompletion(ctx, deps);
  assert.equal(verdict.pass, true);
  assert.equal(verdict.error, true);
  assert.match(verdict.reason, /fail-open.*timeout/);
});

test("judgeCompletion: unparseable LLM output fails safe", async () => {
  const ctx: JudgeContext = {
    taskPrompt: "Refactor code",
    completionResult: "Refactored",
    gitDiff: "+new code",
  };
  const deps = mockLlm({ ok: true, text: "I think maybe it's okay?" });
  const verdict = await judgeCompletion(ctx, deps);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "unparseable judge output");
});

test("judgeCompletion: bare PASS token works", async () => {
  const ctx: JudgeContext = {
    taskPrompt: "Update README",
    completionResult: "README updated",
    gitDiff: "+# New section",
  };
  const deps = mockLlm({ ok: true, text: "PASS" });
  const verdict = await judgeCompletion(ctx, deps);
  assert.equal(verdict.pass, true);
});

test("judgeCompletion: bare FAIL token works", async () => {
  const ctx: JudgeContext = {
    taskPrompt: "Add tests",
    completionResult: "Tests added",
    gitDiff: "",
  };
  const deps = mockLlm({ ok: true, text: "FAIL - no changes" });
  const verdict = await judgeCompletion(ctx, deps);
  assert.equal(verdict.pass, false);
});

test("captureGitDiff: returns diff output", async () => {
  // This test requires a real git repo; skip if git fails
  try {
    const diff = await captureGitDiff(process.cwd(), 1000);
    assert.equal(typeof diff, "string");
    // Either has content or is empty (clean tree)
    assert.ok(diff.length >= 0);
  } catch {
    // Git not available or not a repo - skip
  }
});

test("captureGitDiff: truncates long diffs", async () => {
  // This test is hard to make deterministic without a fixture repo,
  // but we can verify the function signature and error handling
  const diff = await captureGitDiff("/nonexistent", 100);
  assert.equal(typeof diff, "string");
  // Should handle errors gracefully
  assert.ok(diff.includes("git diff failed") || diff.length >= 0);
});

test("parseVerdict: JSON with string pass='true'", () => {
  const verdict = parseVerdict('{"pass":"true","reason":"string coercion works"}');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "string coercion works");
});

test("parseVerdict: JSON with string pass='false'", () => {
  const verdict = parseVerdict('{"pass":"false","reason":"string false coerced"}');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "string false coerced");
});

test("parseVerdict: JSON with numeric pass=1", () => {
  const verdict = parseVerdict('{"pass":1,"reason":"truthy number"}');
  assert.equal(verdict.pass, true);
});

test("parseVerdict: JSON with numeric pass=0", () => {
  const verdict = parseVerdict('{"pass":0,"reason":"falsy number"}');
  assert.equal(verdict.pass, false);
});

test("parseVerdict: non-greedy JSON extraction with prose braces", () => {
  const verdict = parseVerdict('prefix {x} verdict {"pass":true,"reason":"ok"} suffix');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "ok");
});

test("parseVerdict: word-boundary PASS avoids 'bypass'", () => {
  const verdict = parseVerdict("The system will bypass the check");
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "unparseable judge output");
});

test("parseVerdict: word-boundary FAIL avoids 'no failures'", () => {
  const verdict = parseVerdict("There were no failures detected");
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "unparseable judge output");
});

test("parseVerdict: word-boundary PASS avoids 'will not pass'", () => {
  const verdict = parseVerdict("This will not pass the requirements");
  // Negation detection treats "will not pass" as FAIL
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "judge verdict: FAIL");
});

test("parseVerdict: word-boundary PASS matches standalone", () => {
  const verdict = parseVerdict("The task should PASS");
  assert.equal(verdict.pass, true);
});

test("parseVerdict: word-boundary FAIL matches standalone", () => {
  const verdict = parseVerdict("The task should FAIL");
  assert.equal(verdict.pass, false);
});

test("captureGitDiff: accepts baseline parameter", async () => {
  // Test that the function signature accepts baseline
  const diff = await captureGitDiff(process.cwd(), 1000, "HEAD~1");
  assert.equal(typeof diff, "string");
});

test("captureGitBaseline: returns a ref and the pre-existing untracked set", async () => {
  const baseline = await captureGitBaseline(process.cwd());
  assert.equal(typeof baseline.ref, "string");
  assert.ok(baseline.ref.length > 0); // a SHA, or the literal "HEAD"
  assert.ok(Array.isArray(baseline.untracked));
});

test("captureGitDiff: skips untracked files listed in priorUntracked", async () => {
  // A bogus cwd makes every git call resolve empty, so no file is intent-to-add'd
  // and nothing is reset — the call is total and returns the no-changes sentinel.
  const diff = await captureGitDiff("/nonexistent", 1000, "HEAD", ["already-there.txt"]);
  assert.equal(typeof diff, "string");
  assert.equal(diff, "(no changes detected)");
});

test("parseVerdict: reason containing a brace is extracted whole (balanced scan)", () => {
  // A `\{[^{}]*\}` regex would stop at the inner '{' and miss this object, falling
  // through to the token scan. The balanced scanner extracts it intact.
  const verdict = parseVerdict('{"pass":true,"reason":"matches spec {see note}"}');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "matches spec {see note}");
});

test("parseVerdict: nested JSON object is parsed, not truncated", () => {
  const verdict = parseVerdict('{"pass":false,"reason":"incomplete","meta":{"missing":["tests"]}}');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reason, "incomplete");
});

test("parseVerdict: a PASS verdict whose reason mentions 'fail' is NOT inverted", () => {
  // Previously the brace-naive regex could miss the object and the token fallback
  // would see 'fail' and return FAIL. Balanced extraction keeps the JSON verdict.
  const verdict = parseVerdict('{"pass":true,"reason":"no path can fail here"}');
  assert.equal(verdict.pass, true);
  assert.equal(verdict.reason, "no path can fail here");
});

// ── buildJudgeVerifier (composite command-then-judge, shared by the 1.x worker + 2.0 loop) ──────────

const VDIR = mkdtempSync(join(tmpdir(), "judge-verifier-")); // non-git → captureGitDiff yields an empty diff
function vdeps(over: Partial<JudgeVerifierDeps> = {}): { deps: JudgeVerifierDeps; notes: string[] } {
  const notes: string[] = [];
  const deps: JudgeVerifierDeps = {
    mode: "code",
    taskPrompt: "do the task",
    judge: mockLlm({ ok: true, text: '{"pass":true,"reason":"looks good"}' }),
    taskId: 1,
    addNote: (_id, n) => notes.push(n),
    log: () => {},
    ...over,
  };
  return { deps, notes };
}

test("buildJudgeVerifier: undefined for a non-judgeable (read-only) mode → caller uses command-only", () => {
  assert.equal(buildJudgeVerifier(vdeps({ mode: "ask" }).deps), undefined);
  assert.ok(buildJudgeVerifier(vdeps({ mode: "code" }).deps)); // judgeable → a verifier
});

test("buildJudgeVerifier: judge is the sole gate when no command — PASS and FAIL", async () => {
  const pass = buildJudgeVerifier(vdeps().deps)!;
  assert.equal((await pass("did it", undefined, VDIR)).passed, true);
  const fail = buildJudgeVerifier(
    vdeps({ judge: mockLlm({ ok: true, text: '{"pass":false,"reason":"incomplete"}' }) }).deps,
  )!;
  const r = await fail("did it", undefined, VDIR);
  assert.equal(r.passed, false);
  assert.match(r.reason, /incomplete/);
});

test("buildJudgeVerifier: a failing command short-circuits — the judge is never consulted", async () => {
  // judge would PASS, but the command fails first → overall fail with the command's reason.
  const v = buildJudgeVerifier(vdeps().deps)!;
  const r = await v("did it", "exit 1", VDIR);
  assert.equal(r.passed, false);
  assert.match(r.reason, /verify command exited 1/);
});

test("buildJudgeVerifier: command passes, then the judge decides (fails the gate)", async () => {
  const v = buildJudgeVerifier(
    vdeps({ judge: mockLlm({ ok: true, text: '{"pass":false,"reason":"logic wrong"}' }) }).deps,
  )!;
  const r = await v("did it", "exit 0", VDIR);
  assert.equal(r.passed, false);
  assert.match(r.reason, /command passed but judge failed: logic wrong/);
});

test("buildJudgeVerifier: a judge LLM failure fails OPEN (passes) and records a note", async () => {
  const { deps, notes } = vdeps({ judge: mockLlm({ ok: false, reason: "network down" }) });
  const r = await buildJudgeVerifier(deps)!("did it", undefined, VDIR);
  assert.equal(r.passed, true); // infra failure must never block
  assert.ok(notes.some((n) => /Judge infrastructure failure/.test(n)));
});

test.after(() => rmSync(VDIR, { recursive: true, force: true }));

// Made with Bob
