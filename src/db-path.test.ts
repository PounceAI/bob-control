import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultDbPath } from "./db.js";

// defaultDbPath() decides which tasks.db every process (plugin MCP, terminal MCP, worker, CLI)
// opens. When these disagree, await_task polls a board nothing writes to. Pin the precedence so a
// terminal-configured server resolves the SAME project board the plugin does (board-path divergence).
describe("defaultDbPath precedence", () => {
  const KEYS = ["BOB_TASKS_DB", "BOB_TASKS_PORTABLE", "CLAUDE_PROJECT_DIR"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("BOB_TASKS_DB (explicit) wins over everything", () => {
    process.env.BOB_TASKS_DB = "/tmp/explicit/board.db";
    process.env.BOB_TASKS_PORTABLE = "1";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    assert.equal(defaultDbPath(), resolve("/tmp/explicit/board.db"));
  });

  it("BOB_TASKS_PORTABLE beats CLAUDE_PROJECT_DIR (the shared-queue opt-in is explicit)", () => {
    process.env.BOB_TASKS_PORTABLE = "1";
    process.env.CLAUDE_PROJECT_DIR = "/some/project";
    assert.equal(defaultDbPath(), resolve(homedir(), ".bob-tasks", "tasks.db"));
  });

  it("CLAUDE_PROJECT_DIR resolves to <project>/data/tasks.db (terminal == plugin board)", () => {
    process.env.CLAUDE_PROJECT_DIR = resolve("/work/pounce");
    assert.equal(defaultDbPath(), resolve("/work/pounce", "data", "tasks.db"));
  });

  it("ignores empty / whitespace-only env vars (a shell-config slip can't pick a bogus path)", () => {
    process.env.BOB_TASKS_DB = "   "; // whitespace-only → skipped, not resolved to a junk path
    process.env.CLAUDE_PROJECT_DIR = resolve("/work/pounce");
    assert.equal(defaultDbPath(), resolve("/work/pounce", "data", "tasks.db"));
  });

  it("falls back to the module-relative board only when no env hint is set", () => {
    const p = defaultDbPath();
    // No env var set → the connector's own data/tasks.db, not a project- or home-relative path.
    assert.match(p, /[\\/]data[\\/]tasks\.db$/);
    assert.notEqual(p, resolve(homedir(), ".bob-tasks", "tasks.db"));
  });
});
