import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOpts, pickEligible, main } from "./worker.js";

// Import-safety (V2): importing worker.ts must NOT run main() / connect to Bob — the 2.0 in-process
// driver (and tests) reuse its exports. A successful import here IS the assertion that the is-main
// guard holds: without it, importing would run main() and hang/exit the test process.
test("worker.ts is import-safe and exposes its reusable seams", () => {
  assert.equal(typeof main, "function");
  assert.equal(typeof pickEligible, "function");
  assert.equal(typeof parseOpts, "function");
  const opts = parseOpts([]); // pure arg parse → defaults; touches no board / IPC
  assert.equal(opts.once, false);
  assert.equal(typeof opts.pollMs, "number");
});
