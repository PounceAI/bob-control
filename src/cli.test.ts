import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./cli.js";

// Importing cli.js must NOT run the CLI (the run-as-script guard ensures that); if it did, the
// test process would execute a command and exit. Reaching these assertions proves the guard holds.

test("parse: '--flag value' binds the value; a bare '--flag' is boolean true", () => {
  const { flags, positional } = parse(["--priority", "high", "--open"]);
  assert.equal(flags.priority, "high");
  assert.equal(flags.open, true);
  assert.deepEqual(positional, []);
});

test("parse: a flag immediately followed by another flag is boolean, not its value", () => {
  const { flags } = parse(["--a", "--b", "x"]);
  assert.equal(flags.a, true);
  assert.equal(flags.b, "x");
});

test("parse: positionals are collected in order, interleaved with flags", () => {
  const { flags, positional } = parse(["create", "My Title", "--priority", "low", "extra"]);
  assert.deepEqual(positional, ["create", "My Title", "extra"]);
  assert.equal(flags.priority, "low");
});

test("parse: empty argv yields empty flags and positionals", () => {
  const { flags, positional } = parse([]);
  assert.deepEqual(flags, {});
  assert.deepEqual(positional, []);
});
