import { test } from "node:test";
import assert from "node:assert/strict";
import { createPollLoop, type PollDeps, type PollResult, type VerifyResult } from "./bob-polls.js";

// A recording harness: a poll loop wired to fakes that capture each continue
// dispatch, log line, and note, plus a stub verifier the test controls. A continue
// is a re-dispatch (with the full task + failure), so dispatchArgs counts continues.
function harness(
  over: Partial<PollDeps> = {},
  verifyResults: VerifyResult[] = [{ passed: true, reason: "ok" }],
) {
  const logs: string[] = [];
  const notes: Array<{ id: number; note: string; author?: string }> = [];
  const verifyArgs: any[] = [];
  const dispatchArgs: string[] = [];
  let verifyIndex = 0;
  let dispatchIndex = 0;

  const loop = createPollLoop({
    enabled: true,
    maxContinues: 3,
    cwd: "/repo",
    taskPrompt: "Do the original task",
    task: { id: 42, title: "test task" },
    addNote: (id, note, author) => notes.push({ id, note, author }),
    log: (m) => logs.push(m),
    verify: async (result, command, cwd) => {
      verifyArgs.push({ result, command, cwd });
      const v = verifyResults[verifyIndex] ?? verifyResults[verifyResults.length - 1];
      verifyIndex++;
      return v;
    },
    dispatch: async (text) => {
      dispatchArgs.push(text);
      const idx = dispatchIndex++;
      return {
        taskId: `task-${idx}`,
        result: `result from continue #${idx + 1}`,
        lastText: `last text from continue #${idx + 1}`,
        status: "completed" as const,
      };
    },
    ...over,
  });

  return { loop, logs, notes, verifyArgs, dispatchArgs };
}

const initialResult = (result = "initial result"): PollResult => ({
  taskId: "task-0",
  result,
  lastText: "last text",
  status: "completed",
});

test("feature off: returns initial result unchanged, no verification", async () => {
  const h = harness({ enabled: false });
  const result = await h.loop(initialResult());
  assert.equal(result.result, "initial result");
  assert.equal(h.verifyArgs.length, 0, "should not verify when disabled");
  assert.equal(h.dispatchArgs.length, 0);
});

test("passes first try: verifies once, no continues", async () => {
  const h = harness({}, [{ passed: true, reason: "all good" }]);
  const result = await h.loop(initialResult());
  assert.equal(result.result, "initial result");
  assert.equal(h.verifyArgs.length, 1);
  assert.equal(h.dispatchArgs.length, 0, "no continues needed");
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].note, /Verified on first try: all good/);
  assert.equal(h.notes[0].author, "bob-polls");
});

test("fails then passes: one continue", async () => {
  const h = harness({}, [
    { passed: false, reason: "build failed" },
    { passed: true, reason: "fixed" },
  ]);
  const result = await h.loop(initialResult());
  assert.equal(h.verifyArgs.length, 2, "verify initial + continue");
  assert.equal(h.dispatchArgs.length, 1, "one continue dispatch");
  assert.match(h.dispatchArgs[0], /build failed/);
  assert.equal(result.result, "result from continue #1");
  assert.equal(h.notes.length, 2);
  assert.match(h.notes[0].note, /Continue #1: build failed/);
  assert.match(h.notes[1].note, /Verified after 1 continue/);
});

test("fails past the cap: marks as blocked", async () => {
  const h = harness({ maxContinues: 2 }, [
    { passed: false, reason: "fail 1" },
    { passed: false, reason: "fail 2" },
    { passed: false, reason: "fail 3" },
  ]);
  const result = await h.loop(initialResult());
  assert.equal(h.verifyArgs.length, 3, "verify initial + 2 continues");
  assert.equal(h.dispatchArgs.length, 2, "two continue dispatches");
  assert.equal(result.status, "aborted", "should mark as failed");
  assert.equal(h.notes.length, 3);
  assert.match(h.notes[2].note, /Verification failed after 2 continue/);
  assert.match(h.notes[2].note, /fail 3/);
});

test("no result to verify: skips verification", async () => {
  const h = harness();
  await h.loop({ taskId: "t", result: "", lastText: "", status: "timeout" });
  assert.equal(h.verifyArgs.length, 0);
  assert.match(h.logs.join("\n"), /no result to verify/);
});

test("whitespace-only result: skips verification", async () => {
  const h = harness();
  await h.loop({ taskId: "t", result: "   \n\t  ", lastText: "", status: "completed" });
  assert.equal(h.verifyArgs.length, 0);
});

test("continue produces no result: stops looping", async () => {
  const dispatched: string[] = [];
  const loop = createPollLoop({
    enabled: true,
    maxContinues: 5,
    cwd: "/repo",
    taskPrompt: "task",
    task: { id: 42, title: "test task" },
    addNote: () => {},
    log: () => {},
    verify: async () => ({ passed: false, reason: "fail" }),
    dispatch: async (t) => {
      dispatched.push(t);
      return { taskId: "t", result: "", lastText: "", status: "timeout" };
    },
  });
  const result = await loop(initialResult());
  assert.equal(dispatched.length, 1, "one continue attempted, then stops");
  assert.equal(result.status, "timeout");
});

test("forwards verify command to verifier", async () => {
  const h = harness({ verifyCommand: "npm test" });
  await h.loop(initialResult());
  assert.equal(h.verifyArgs[0].command, "npm test");
  assert.equal(h.verifyArgs[0].cwd, "/repo");
});

test("no verify command: forwards undefined to the verifier", async () => {
  const h = harness({ verifyCommand: undefined });
  await h.loop(initialResult());
  assert.equal(h.verifyArgs[0].command, undefined);
});

test("multiple continues: each re-dispatches with its failure", async () => {
  const h = harness({ maxContinues: 3 }, [
    { passed: false, reason: "error A" },
    { passed: false, reason: "error B" },
    { passed: true, reason: "fixed" },
  ]);
  await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 2);
  assert.match(h.dispatchArgs[0], /error A/);
  assert.match(h.dispatchArgs[1], /error B/);
  assert.equal(h.notes.length, 3);
  assert.match(h.notes[0].note, /Continue #1: error A/);
  assert.match(h.notes[1].note, /Continue #2: error B/);
  assert.match(h.notes[2].note, /Verified after 2 continue/);
});

test("logs show continue count", async () => {
  const h = harness({}, [
    { passed: false, reason: "fail" },
    { passed: true, reason: "ok" },
  ]);
  await h.loop(initialResult());
  const continueLog = h.logs.find((l) => /continue #1/.test(l));
  assert.ok(continueLog, "should log continue number");
});

test("max continues of 0: no continues allowed", async () => {
  const h = harness({ maxContinues: 0 }, [{ passed: false, reason: "fail" }]);
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 0, "no continues dispatched");
  assert.equal(result.status, "aborted");
  assert.match(h.notes[0].note, /Verification failed after 0 continue/);
});

test("max continues of 1: allows exactly one continue", async () => {
  const h = harness({ maxContinues: 1 }, [
    { passed: false, reason: "fail 1" },
    { passed: false, reason: "fail 2" },
  ]);
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 1, "one continue dispatched");
  assert.equal(h.verifyArgs.length, 2, "verify initial + 1 continue");
  assert.equal(result.status, "aborted");
});

test("verify is called with the result text", async () => {
  const h = harness();
  await h.loop(initialResult("my custom result"));
  assert.equal(h.verifyArgs[0].result, "my custom result");
});

test("continue re-dispatches the full task plus the failure (context preserved)", async () => {
  const h = harness({}, [{ passed: false, reason: "test failed" }, { passed: true, reason: "ok" }]);
  await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 1);
  assert.match(h.dispatchArgs[0], /Do the original task/, "carries the original task context");
  assert.match(h.dispatchArgs[0], /test failed/, "carries the failure reason");
  assert.match(h.dispatchArgs[0], /Fix the problem/);
});

test("each continue result is verified", async () => {
  const h = harness({}, [
    { passed: false, reason: "fail 1" },
    { passed: false, reason: "fail 2" },
    { passed: true, reason: "ok" },
  ]);
  await h.loop(initialResult("initial"));
  assert.equal(h.verifyArgs.length, 3);
  assert.equal(h.verifyArgs[0].result, "initial");
  assert.equal(h.verifyArgs[1].result, "result from continue #1");
  assert.equal(h.verifyArgs[2].result, "result from continue #2");
});

test("task id is included in notes", async () => {
  const h = harness({ task: { id: 99, title: "special task" } });
  await h.loop(initialResult());
  assert.equal(h.notes[0].id, 99);
});

test("aborted initial result: skips verification", async () => {
  const h = harness();
  const result = await h.loop({ taskId: "t", result: "", lastText: "", status: "aborted" });
  assert.equal(h.verifyArgs.length, 0);
  assert.equal(result.status, "aborted");
});

test("timeout initial result: skips verification", async () => {
  const h = harness();
  const result = await h.loop({ taskId: "t", result: "", lastText: "", status: "timeout" });
  assert.equal(h.verifyArgs.length, 0);
  assert.equal(result.status, "timeout");
});

// Plan-stop detection tests

test("plan-stop detection off: does not check for work", async () => {
  const workCheckArgs: any[] = [];
  const snapshotArgs: any[] = [];
  const h = harness({
    detectPlanStop: false,
    captureSnapshot: async (cwd) => {
      snapshotArgs.push({ cwd });
      return "snapshot";
    },
    checkDidWork: async (cwd, baseline) => {
      workCheckArgs.push({ cwd, baseline });
      return { didWork: false, reason: "clean" };
    },
  });
  await h.loop(initialResult());
  assert.equal(snapshotArgs.length, 0, "should not capture snapshot when feature is off");
  assert.equal(workCheckArgs.length, 0, "should not check work when feature is off");
});

test("plan-stop detection on + work detected: proceeds to verification", async () => {
  const workCheckArgs: any[] = [];
  const h = harness({
    detectPlanStop: true,
    captureSnapshot: async () => "baseline-snapshot",
    checkDidWork: async (cwd, baseline) => {
      workCheckArgs.push({ cwd, baseline });
      return { didWork: true, reason: "3 files changed" };
    },
  });
  const result = await h.loop(initialResult());
  assert.equal(workCheckArgs.length, 1, "should check work once");
  assert.equal(workCheckArgs[0].baseline, "baseline-snapshot");
  assert.equal(h.verifyArgs.length, 1, "should proceed to verification");
  assert.equal(result.result, "initial result");
  assert.match(h.logs.join("\n"), /work detected.*3 files changed/);
});

test("plan-stop detection on + no work: continues with plan-stop message", async () => {
  let checkCount = 0;
  let snapshotCount = 0;
  const h = harness(
    {
      detectPlanStop: true,
      captureSnapshot: async () => `snapshot-${++snapshotCount}`,
      checkDidWork: async (cwd, baseline) => {
        checkCount++;
        // First check: no work. After continue: work detected.
        return checkCount === 1
          ? { didWork: false, reason: "working tree unchanged from baseline" }
          : { didWork: true, reason: "files changed" };
      },
    },
    [{ passed: true, reason: "ok" }],
  );
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 1, "should dispatch a continue");
  assert.match(h.dispatchArgs[0], /presented a plan but did NOT implement it/);
  assert.match(h.dispatchArgs[0], /working tree has no changes/);
  assert.match(h.dispatchArgs[0], /Implement the code/);
  assert.equal(h.notes.length, 2);
  assert.match(h.notes[0].note, /Continue #1: plan-stop/);
  assert.match(h.notes[1].note, /Verified after 1 continue/);
  assert.equal(result.result, "result from continue #1");
  assert.equal(snapshotCount, 2, "should re-capture snapshot after continue");
});

test("plan-stop detection: no work then work then verify pass", async () => {
  let checkCount = 0;
  let snapshotCount = 0;
  const h = harness(
    {
      detectPlanStop: true,
      captureSnapshot: async () => `snapshot-${++snapshotCount}`,
      checkDidWork: async (cwd, baseline) => {
        checkCount++;
        if (checkCount === 1) return { didWork: false, reason: "unchanged from baseline" };
        return { didWork: true, reason: "files changed" };
      },
    },
    [{ passed: true, reason: "ok" }],
  );
  const result = await h.loop(initialResult());
  assert.equal(checkCount, 2, "should check work twice (initial + continue)");
  assert.equal(snapshotCount, 2, "should capture snapshot twice (initial + after continue)");
  assert.equal(h.dispatchArgs.length, 1, "one continue for plan-stop");
  assert.equal(h.verifyArgs.length, 1, "verify once after work detected");
  assert.equal(result.result, "result from continue #1");
});

test("plan-stop detection: hits max continues with no work", async () => {
  const h = harness(
    {
      detectPlanStop: true,
      maxContinues: 2,
      captureSnapshot: async () => "same-snapshot",
      checkDidWork: async () => ({ didWork: false, reason: "still unchanged" }),
    },
    [],
  );
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 2, "two continues before giving up");
  assert.equal(result.status, "aborted", "should mark as failed");
  assert.match(h.notes[2].note, /Plan-stop.*after 2 continue/);
  assert.match(h.notes[2].note, /still unchanged/);
});

test("plan-stop detection: no work, then work, then verify fail, then verify pass", async () => {
  let checkCount = 0;
  let snapshotCount = 0;
  const h = harness(
    {
      detectPlanStop: true,
      captureSnapshot: async () => `snapshot-${++snapshotCount}`,
      checkDidWork: async (cwd, baseline) => {
        checkCount++;
        if (checkCount === 1) return { didWork: false, reason: "unchanged" };
        return { didWork: true, reason: "changed" };
      },
    },
    [
      { passed: false, reason: "tests failed" },
      { passed: true, reason: "fixed" },
    ],
  );
  const result = await h.loop(initialResult());
  assert.equal(checkCount, 3, "check work 3 times: initial, after plan-stop continue, after verify continue");
  assert.equal(snapshotCount, 3, "capture snapshot 3 times: initial, after plan-stop continue, after verify continue");
  assert.equal(h.dispatchArgs.length, 2, "two continues: plan-stop + verify fail");
  assert.match(h.dispatchArgs[0], /presented a plan but did NOT implement/);
  assert.match(h.dispatchArgs[1], /did NOT pass verification: tests failed/);
  assert.equal(h.verifyArgs.length, 2, "verify twice: after first work, after second work");
  assert.equal(result.result, "result from continue #2");
});

test("plan-stop detection: continue produces no result, stops looping", async () => {
  const dispatched: string[] = [];
  const loop = createPollLoop({
    enabled: true,
    detectPlanStop: true,
    maxContinues: 5,
    cwd: "/repo",
    taskPrompt: "task",
    task: { id: 42, title: "test task" },
    addNote: () => {},
    log: () => {},
    captureSnapshot: async () => "snapshot",
    checkDidWork: async () => ({ didWork: false, reason: "unchanged" }),
    verify: async () => ({ passed: true, reason: "ok" }),
    dispatch: async (t) => {
      dispatched.push(t);
      return { taskId: "t", result: "", lastText: "", status: "timeout" };
    },
  });
  const result = await loop(initialResult());
  assert.equal(dispatched.length, 1, "one continue attempted for plan-stop, then stops");
  assert.equal(result.status, "timeout");
});

test("plan-stop detection: forwards cwd to checkDidWork and baseline", async () => {
  const workCheckArgs: any[] = [];
  const h = harness({
    detectPlanStop: true,
    cwd: "/my/custom/path",
    captureSnapshot: async () => "test-baseline",
    checkDidWork: async (cwd, baseline) => {
      workCheckArgs.push({ cwd, baseline });
      return { didWork: true, reason: "ok" };
    },
  });
  await h.loop(initialResult());
  assert.equal(workCheckArgs[0].cwd, "/my/custom/path");
  assert.equal(workCheckArgs[0].baseline, "test-baseline");
});

// Snapshot-based detection tests

test("snapshot unchanged: detects plan-stop", async () => {
  let checkCount = 0;
  const h = harness({
    detectPlanStop: true,
    captureSnapshot: async () => "SAME_SNAPSHOT",
    checkDidWork: async (cwd, baseline) => {
      checkCount++;
      // First check: no work. After continue: work detected.
      return checkCount === 1
        ? { didWork: false, reason: "working tree unchanged from baseline" }
        : { didWork: true, reason: "changed" };
    },
  });
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 1, "should continue for plan-stop");
  assert.match(h.dispatchArgs[0], /presented a plan but did NOT implement/);
});

test("snapshot changed: detects work done", async () => {
  let snapshotCount = 0;
  const h = harness({
    detectPlanStop: true,
    captureSnapshot: async () => `snapshot-${++snapshotCount}`,
    checkDidWork: async (cwd, baseline) => {
      // Different snapshots = work detected
      return { didWork: true, reason: "2 new file changes detected" };
    },
  });
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 0, "should not continue when work detected");
  assert.equal(h.verifyArgs.length, 1, "should proceed to verification");
  assert.match(h.logs.join("\n"), /work detected.*2 new file changes/);
});

test("baseline provided externally: uses it instead of capturing", async () => {
  const snapshotArgs: any[] = [];
  const workCheckArgs: any[] = [];
  const h = harness({
    detectPlanStop: true,
    captureSnapshot: async (cwd) => {
      snapshotArgs.push({ cwd });
      return "internal-snapshot";
    },
    checkDidWork: async (cwd, baseline) => {
      workCheckArgs.push({ cwd, baseline });
      return { didWork: true, reason: "ok" };
    },
  });
  await h.loop(initialResult(), "external-baseline");
  assert.equal(snapshotArgs.length, 0, "should not capture when baseline provided");
  assert.equal(workCheckArgs[0].baseline, "external-baseline", "should use provided baseline");
});

test("git error in snapshot: conservatively assumes work done", async () => {
  const h = harness({
    detectPlanStop: true,
    captureSnapshot: async () => "GIT_ERROR",
    checkDidWork: async (cwd, baseline) => {
      if (baseline === "GIT_ERROR") {
        return { didWork: true, reason: "git check failed, assuming work done" };
      }
      return { didWork: false, reason: "unchanged" };
    },
  });
  const result = await h.loop(initialResult());
  assert.equal(h.dispatchArgs.length, 0, "should not continue on git error");
  assert.match(h.logs.join("\n"), /work detected.*git check failed/);
});

test("plan-stop detection: combines with verify-and-continue correctly", async () => {
  let checkCount = 0;
  let snapshotCount = 0;
  const h = harness(
    {
      detectPlanStop: true,
      verifyCommand: "npm test",
      captureSnapshot: async () => `snapshot-${++snapshotCount}`,
      checkDidWork: async (cwd, baseline) => {
        checkCount++;
        // First check: no work. After continue: work detected.
        return checkCount === 1
          ? { didWork: false, reason: "unchanged" }
          : { didWork: true, reason: "changed" };
      },
    },
    [
      { passed: false, reason: "build failed" },
      { passed: true, reason: "ok" },
    ],
  );
  const result = await h.loop(initialResult());
  // Flow: initial (no work) -> plan-stop continue -> work detected -> verify fail -> verify continue -> verify pass
  assert.equal(checkCount, 3, "check work 3 times");
  assert.equal(snapshotCount, 3, "capture snapshot 3 times");
  assert.equal(h.dispatchArgs.length, 2, "two continues: plan-stop + verify");
  assert.equal(h.verifyArgs.length, 2, "verify twice after work detected");
  assert.match(h.dispatchArgs[0], /presented a plan/);
  assert.match(h.dispatchArgs[1], /did NOT pass verification/);
});
