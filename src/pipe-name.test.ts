import { test } from "node:test";
import assert from "node:assert/strict";
import { bobPipeName, sameWorkspace } from "./pipe-name.js";

// bobPipeName must give each workspace a DISTINCT, STABLE pipe name — the per-instance routing the
// cross-fire fix depends on. Windows-oriented: case- and separator-insensitive.

test("distinct workspace paths get distinct names", () => {
  assert.notEqual(bobPipeName("C:\\repos\\app-a"), bobPipeName("C:\\repos\\app-b"));
});

test("same path is stable across case, separator, trailing-slash, and ./.. variants (each isolated)", () => {
  const a = bobPipeName("C:\\vsPounceProject\\bob-control");
  assert.equal(bobPipeName("c:\\vsPounceProject\\bob-control"), a); // case only (drive)
  assert.equal(bobPipeName("C:\\VSPounceProject\\BOB-control"), a); // case only (body)
  assert.equal(bobPipeName("C:/vsPounceProject/bob-control"), a); // separator only
  assert.equal(bobPipeName("C:\\vsPounceProject\\bob-control\\"), a); // trailing slash only
  assert.equal(bobPipeName("C:\\vsPounceProject\\.\\bob-control"), a); // redundant .
  assert.equal(bobPipeName("C:\\vsPounceProject\\sub\\..\\bob-control"), a); // .. backtrack
  assert.equal(bobPipeName("C:\\vsPounceProject\\\\bob-control"), a); // duplicate separator
});

test("same basename under different parents stays distinct (hash disambiguates)", () => {
  assert.notEqual(bobPipeName("C:\\repos\\app"), bobPipeName("C:\\other\\app"));
});

test("name is a raw \\\\.\\pipe\\bob-ipc- pipe carrying the readable basename", () => {
  assert.match(bobPipeName("C:\\repos\\bob-control"), /^\\\\\.\\pipe\\bob-ipc-bob-control-[0-9a-f]{12}$/);
});

test("a basename longer than 32 chars never leaves a stray trailing dash before the hash", () => {
  const name = bobPipeName("C:\\repos\\" + "x".repeat(31) + "-yyyy");
  assert.doesNotMatch(name, /--/);
  assert.match(name, /-[0-9a-f]{12}$/);
});

test("blank path throws (the launcher must pass a workspace)", () => {
  assert.throws(() => bobPipeName(""));
  assert.throws(() => bobPipeName("   "));
});

// sameWorkspace powers the worker's layer-2 guard: it must treat the same folder as equal across
// Windows path spellings, and NEVER read blank/garbage as a match (that would silence a real misroute).
test("sameWorkspace folds the same folder across case, separator, trailing-slash, and ./.. variants", () => {
  const a = "C:\\vsPounceProject\\bob-control";
  assert.ok(sameWorkspace(a, "c:/VSPounceProject/BOB-control/")); // case + separator + trailing slash
  assert.ok(sameWorkspace(a, "C:\\vsPounceProject\\.\\bob-control")); // redundant .
  assert.ok(sameWorkspace(a, "C:\\vsPounceProject\\sub\\..\\bob-control")); // .. backtrack
});

test("sameWorkspace keeps distinct folders distinct (worktree vs. main checkout)", () => {
  assert.ok(!sameWorkspace("C:\\repos\\app", "C:\\repos\\app-wt2"));
  assert.ok(!sameWorkspace("C:\\repos\\app", "C:\\other\\app"));
});

test("sameWorkspace never treats a blank/missing path as a match", () => {
  assert.ok(!sameWorkspace("C:\\repos\\app", ""));
  assert.ok(!sameWorkspace("C:\\repos\\app", "   "));
  assert.ok(!sameWorkspace("", "C:\\repos\\app"));
  assert.ok(!sameWorkspace(null, "C:\\repos\\app"));
  assert.ok(!sameWorkspace("C:\\repos\\app", undefined));
});
