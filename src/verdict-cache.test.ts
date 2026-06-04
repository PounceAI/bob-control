import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictCache } from "./verdict-cache.js";
import type { Classification } from "./classify.js";

test("VerdictCache: store and retrieve a verdict", () => {
  const cache = new VerdictCache();
  const classification: Classification = { decision: "approve", reason: "safe build command" };

  cache.set("npm run build", "/home/user/project", classification);
  const result = cache.get("npm run build", "/home/user/project");

  assert.deepEqual(result, classification);
});

test("VerdictCache: return undefined for cache miss", () => {
  const cache = new VerdictCache();
  const result = cache.get("npm test", "/home/user/project");
  assert.equal(result, undefined);
});

test("VerdictCache: differentiate commands by cwd", () => {
  const cache = new VerdictCache();
  const approve: Classification = { decision: "approve", reason: "safe in project" };
  const deny: Classification = { decision: "deny", reason: "dangerous elsewhere" };

  cache.set("rm -rf build", "/home/user/project", approve);
  cache.set("rm -rf build", "/home/user/other", deny);

  assert.deepEqual(cache.get("rm -rf build", "/home/user/project"), approve);
  assert.deepEqual(cache.get("rm -rf build", "/home/user/other"), deny);
});

test("VerdictCache: cache all decision types including ask", () => {
  const cache = new VerdictCache();
  const approve: Classification = { decision: "approve", reason: "safe" };
  const deny: Classification = { decision: "deny", reason: "dangerous" };
  const ask: Classification = { decision: "ask", reason: "uncertain" };

  cache.set("cmd1", "/cwd", approve);
  cache.set("cmd2", "/cwd", deny);
  cache.set("cmd3", "/cwd", ask);

  assert.equal(cache.get("cmd1", "/cwd")?.decision, "approve");
  assert.equal(cache.get("cmd2", "/cwd")?.decision, "deny");
  assert.equal(cache.get("cmd3", "/cwd")?.decision, "ask");
});

test("VerdictCache: update access order on get", () => {
  const cache = new VerdictCache(3);
  const c1: Classification = { decision: "approve", reason: "1" };
  const c2: Classification = { decision: "approve", reason: "2" };
  const c3: Classification = { decision: "approve", reason: "3" };
  const c4: Classification = { decision: "approve", reason: "4" };

  cache.set("cmd1", "/cwd", c1);
  cache.set("cmd2", "/cwd", c2);
  cache.set("cmd3", "/cwd", c3);

  // Access cmd1 to make it most recent
  cache.get("cmd1", "/cwd");

  // Add cmd4, should evict cmd2 (least recent)
  cache.set("cmd4", "/cwd", c4);

  assert.notEqual(cache.get("cmd1", "/cwd"), undefined, "cmd1 should still be cached");
  assert.equal(cache.get("cmd2", "/cwd"), undefined, "cmd2 should be evicted");
  assert.notEqual(cache.get("cmd3", "/cwd"), undefined, "cmd3 should still be cached");
  assert.notEqual(cache.get("cmd4", "/cwd"), undefined, "cmd4 should be cached");
});

test("VerdictCache: evict LRU entry when cache is full", () => {
  const cache = new VerdictCache(2);
  const c1: Classification = { decision: "approve", reason: "1" };
  const c2: Classification = { decision: "approve", reason: "2" };
  const c3: Classification = { decision: "approve", reason: "3" };

  cache.set("cmd1", "/cwd", c1);
  cache.set("cmd2", "/cwd", c2);
  assert.equal(cache.size(), 2);

  // Adding cmd3 should evict cmd1 (oldest)
  cache.set("cmd3", "/cwd", c3);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get("cmd1", "/cwd"), undefined, "cmd1 should be evicted");
  assert.notEqual(cache.get("cmd2", "/cwd"), undefined, "cmd2 should remain");
  assert.notEqual(cache.get("cmd3", "/cwd"), undefined, "cmd3 should be cached");
});

test("VerdictCache: update existing entry without growing cache", () => {
  const cache = new VerdictCache(2);
  const c1: Classification = { decision: "approve", reason: "first" };
  const c2: Classification = { decision: "deny", reason: "updated" };

  cache.set("cmd1", "/cwd", c1);
  assert.equal(cache.size(), 1);

  cache.set("cmd1", "/cwd", c2);
  assert.equal(cache.size(), 1);
  assert.equal(cache.get("cmd1", "/cwd")?.reason, "updated");
});

test("VerdictCache: clear all entries", () => {
  const cache = new VerdictCache();
  const c: Classification = { decision: "approve", reason: "test" };

  cache.set("cmd1", "/cwd", c);
  cache.set("cmd2", "/cwd", c);
  assert.equal(cache.size(), 2);

  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get("cmd1", "/cwd"), undefined);
  assert.equal(cache.get("cmd2", "/cwd"), undefined);
});

test("VerdictCache: throw on invalid maxSize", () => {
  assert.throws(() => new VerdictCache(0), /maxSize must be >= 1/);
  assert.throws(() => new VerdictCache(-1), /maxSize must be >= 1/);
});

test("VerdictCache: handle maxSize of 1", () => {
  const cache = new VerdictCache(1);
  const c1: Classification = { decision: "approve", reason: "1" };
  const c2: Classification = { decision: "approve", reason: "2" };

  cache.set("cmd1", "/cwd", c1);
  assert.equal(cache.size(), 1);

  cache.set("cmd2", "/cwd", c2);
  assert.equal(cache.size(), 1);
  assert.equal(cache.get("cmd1", "/cwd"), undefined);
  assert.notEqual(cache.get("cmd2", "/cwd"), undefined);
});

test("VerdictCache: handle commands with special characters in key", () => {
  const cache = new VerdictCache();
  const c: Classification = { decision: "approve", reason: "test" };

  // Commands and paths with :: separator characters
  cache.set("echo 'test::value'", "/path::with::colons", c);
  const result = cache.get("echo 'test::value'", "/path::with::colons");

  assert.deepEqual(result, c);
});
