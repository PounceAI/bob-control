import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApiReqUsage, BudgetTracker, computeCeiling, budgetExceeded } from "./budget.js";

test("parseApiReqUsage reads token counts from an api_req payload", () => {
  const u = parseApiReqUsage('{"request":"...","tokensIn":1234,"tokensOut":56,"cost":0.01}');
  assert.deepEqual(u, { tokensIn: 1234, tokensOut: 56, cost: 0.01 });
});

test("parseApiReqUsage tolerates field-name variants", () => {
  assert.deepEqual(parseApiReqUsage('{"inputTokens":10,"outputTokens":20}'), {
    tokensIn: 10,
    tokensOut: 20,
    cost: undefined,
  });
});

test("parseApiReqUsage reads counts nested under a usage-ish object (wire-shape tolerance)", () => {
  assert.deepEqual(parseApiReqUsage('{"request":"…","usage":{"inputTokens":12,"outputTokens":34,"cost":0.02}}'), {
    tokensIn: 12,
    tokensOut: 34,
    cost: 0.02,
  });
  // Top-level wins when both are present.
  assert.deepEqual(parseApiReqUsage('{"tokensOut":5,"usage":{"outputTokens":99}}'), {
    tokensIn: undefined,
    tokensOut: 5,
    cost: undefined,
  });
});

test("parseApiReqUsage returns null for non-JSON, empty, or count-less payloads", () => {
  assert.equal(parseApiReqUsage("not json"), null);
  assert.equal(parseApiReqUsage(""), null);
  assert.equal(parseApiReqUsage(undefined), null);
  assert.equal(parseApiReqUsage('{"request":"starting, no counts yet"}'), null);
});

test("BudgetTracker keys by ts: re-emissions of one request update (not inflate); distinct ts add up", () => {
  const t = new BudgetTracker();
  // One request streams: same ts re-emitted with growing counts → last-wins.
  t.update(100, { tokensOut: 10 });
  t.update(100, { tokensOut: 40 });
  assert.equal(t.outputTokens, 40, "re-emission updated, did not double-count");
  assert.equal(t.turns, 1, "still one request");
  // A second request (new ts) accumulates.
  t.update(200, { tokensOut: 25, tokensIn: 5 });
  assert.equal(t.outputTokens, 65);
  assert.equal(t.totalTokens, 70);
  assert.equal(t.turns, 2);
});

test("BudgetTracker folds ts-less usage into a single anonymous slot", () => {
  const t = new BudgetTracker();
  t.update(undefined, { tokensOut: 100 });
  t.update(undefined, { tokensOut: 150 });
  assert.equal(t.outputTokens, 150, "anonymous slot is last-wins, not summed");
  assert.equal(t.turns, 1);
});

test("computeCeiling: estimate + headroom, floored; flat cap when no estimate", () => {
  const opts = { headroomPct: 15, floor: 50_000, flatCap: 100_000 };
  // Big estimate → estimate × 1.15.
  assert.equal(computeCeiling(80_000, opts), 92_000);
  // Tiny estimate → floored so real work isn't aborted early.
  assert.equal(computeCeiling(10_000, opts), 50_000);
  // No estimate → flat cap.
  assert.equal(computeCeiling(undefined, opts), 100_000);
  assert.equal(computeCeiling(0, opts), 100_000);
});

test("budgetExceeded trips on the token ceiling", () => {
  assert.equal(budgetExceeded({ outputTokens: 40_000, turns: 5 }, { tokenCeiling: 50_000 }), null);
  const reason = budgetExceeded({ outputTokens: 60_000, turns: 5 }, { tokenCeiling: 50_000 });
  assert.ok(reason && /output tokens 60000 exceeded ceiling 50000/.test(reason));
});

test("budgetExceeded trips on the turn cap", () => {
  assert.equal(budgetExceeded({ outputTokens: 1, turns: 200 }, { turnCap: 200 }), null);
  const reason = budgetExceeded({ outputTokens: 1, turns: 201 }, { turnCap: 200 });
  assert.ok(reason && /turns 201 exceeded cap 200/.test(reason));
});

test("budgetExceeded with no limits never trips (disabled)", () => {
  assert.equal(budgetExceeded({ outputTokens: 1e9, turns: 1e9 }, {}), null);
  assert.equal(budgetExceeded({ outputTokens: 1e9, turns: 1e9 }, { tokenCeiling: 0, turnCap: 0 }), null);
});

test("end-to-end: tracker output feeds budgetExceeded", () => {
  const t = new BudgetTracker();
  const ceiling = computeCeiling(20_000, { headroomPct: 15, floor: 23_000, flatCap: 100_000 }); // 23_000
  t.update(1, { tokensOut: 22_000 });
  assert.equal(budgetExceeded(t, { tokenCeiling: ceiling }), null, "under ceiling");
  t.update(2, { tokensOut: 2_000 }); // total 24_000 > 23_000
  assert.ok(budgetExceeded(t, { tokenCeiling: ceiling }), "over ceiling after the second request");
});
