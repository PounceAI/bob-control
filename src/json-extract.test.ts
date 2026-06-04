import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObjects, parseFirstJsonObject } from "./json-extract.js";

test("extractJsonObjects returns each top-level balanced object in order", () => {
  assert.deepEqual(extractJsonObjects('a {"x":1} b {"y":2} c'), ['{"x":1}', '{"y":2}']);
  assert.deepEqual(extractJsonObjects("no json here"), []);
});

test("extractJsonObjects is brace-aware inside strings and nested objects", () => {
  assert.deepEqual(extractJsonObjects('{"reason":"see {x} and }"}'), ['{"reason":"see {x} and }"}']);
  assert.deepEqual(extractJsonObjects('{"a":{"b":1}}'), ['{"a":{"b":1}}']);
  // An escaped quote must not end the string early (so the inner } stays inside the string).
  assert.deepEqual(extractJsonObjects('{"q":"a \\" } brace"}'), ['{"q":"a \\" } brace"}']);
});

test("extractJsonObjects ignores an unterminated trailing object", () => {
  assert.deepEqual(extractJsonObjects('{"ok":1} then {"truncated":'), ['{"ok":1}']);
});

test("parseFirstJsonObject returns the first PARSEABLE object, tolerating trailing braces", () => {
  // The exact case the greedy /\{[\s\S]*\}/ broke on: valid JSON followed by another brace.
  assert.deepEqual(parseFirstJsonObject('{"decision":"approve","reason":"x"}\nNote: see {y}'), {
    decision: "approve",
    reason: "x",
  });
  // Skips a balanced-but-invalid object and returns the next valid one.
  assert.deepEqual(parseFirstJsonObject('{not json} {"ok":true}'), { ok: true });
  assert.equal(parseFirstJsonObject("nothing here"), null);
  assert.equal(parseFirstJsonObject('{"truncated":'), null);
});
