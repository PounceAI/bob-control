import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { defaultDbPath, sharedWorktreeBoard } from "./db.js";

// defaultDbPath() decides which tasks.db every process (plugin MCP, terminal MCP, worker, CLI)
// opens. When these disagree, await_task polls a board nothing writes to. Pin the precedence so a
// terminal-configured server resolves the SAME project board the plugin does (board-path divergence).
describe("defaultDbPath precedence", () => {
  const KEYS = ["BOB_TASKS_DB", "BOB_TASKS_PORTABLE", "CLAUDE_PROJECT_DIR", "BOB_TASKS_WORKTREE_SHARED"] as const;
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
    process.env.CLAUDE_PROJECT_DIR = resolve("/work/project");
    assert.equal(defaultDbPath(), resolve("/work/project", "data", "tasks.db"));
  });

  it("ignores empty / whitespace-only env vars (a shell-config slip can't pick a bogus path)", () => {
    process.env.BOB_TASKS_DB = "   "; // whitespace-only → skipped, not resolved to a junk path
    process.env.CLAUDE_PROJECT_DIR = resolve("/work/project");
    assert.equal(defaultDbPath(), resolve("/work/project", "data", "tasks.db"));
  });

  it("falls back to the module-relative board only when no env hint is set", () => {
    const p = defaultDbPath();
    // No env var set → the connector's own data/tasks.db, not a project- or home-relative path.
    assert.match(p, /[\\/]data[\\/]tasks\.db$/);
    assert.notEqual(p, resolve(homedir(), ".bob-tasks", "tasks.db"));
  });
});

// BOB_TASKS_WORKTREE_SHARED: every linked worktree of a repo resolves the MAIN worktree's board, so
// concurrent worktrees drain one queue. Resolution is sync (.git inspection, no git spawn). The flag is
// a no-op for a plain clone / non-git dir, so it only redirects actual linked worktrees.
describe("defaultDbPath worktree-shared board", () => {
  const KEYS = ["BOB_TASKS_DB", "BOB_TASKS_PORTABLE", "CLAUDE_PROJECT_DIR", "BOB_TASKS_WORKTREE_SHARED"] as const;
  let saved: Record<string, string | undefined>;
  let tmp: string; // scratch root, removed in afterEach
  let main: string; // main worktree (real .git dir)
  let linked: string; // linked worktree (.git file → main/.git/worktrees/feat)

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    tmp = mkdtempSync(join(tmpdir(), "bob-wt-"));
    main = join(tmp, "repo");
    linked = join(tmp, "repo-feat");
    mkdirSync(join(main, ".git", "worktrees", "feat"), { recursive: true });
    mkdirSync(linked, { recursive: true });
    // git writes the gitdir with forward slashes; emulate that.
    const gitdir = join(main, ".git", "worktrees", "feat").replace(/\\/g, "/");
    writeFileSync(join(linked, ".git"), `gitdir: ${gitdir}\n`);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("flag on + linked worktree → the MAIN worktree's board", () => {
    process.env.BOB_TASKS_WORKTREE_SHARED = "1";
    process.env.CLAUDE_PROJECT_DIR = linked;
    assert.equal(defaultDbPath(), resolve(main, "data", "tasks.db"));
  });

  it("flag on + main worktree (.git dir) → its own board (no-op redirect)", () => {
    process.env.BOB_TASKS_WORKTREE_SHARED = "1";
    process.env.CLAUDE_PROJECT_DIR = main;
    assert.equal(defaultDbPath(), resolve(main, "data", "tasks.db"));
  });

  it("flag OFF + linked worktree → per-dir board (today's behavior preserved)", () => {
    process.env.CLAUDE_PROJECT_DIR = linked;
    assert.equal(defaultDbPath(), resolve(linked, "data", "tasks.db"));
  });

  it("flag on + non-git dir → falls through to per-dir resolution", () => {
    const plain = join(tmp, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    process.env.BOB_TASKS_WORKTREE_SHARED = "1";
    process.env.CLAUDE_PROJECT_DIR = plain;
    assert.equal(defaultDbPath(), resolve(plain, "data", "tasks.db"));
  });

  it("explicit BOB_TASKS_DB still wins over the flag", () => {
    process.env.BOB_TASKS_WORKTREE_SHARED = "1";
    process.env.CLAUDE_PROJECT_DIR = linked;
    process.env.BOB_TASKS_DB = join(tmp, "explicit.db");
    assert.equal(defaultDbPath(), resolve(join(tmp, "explicit.db")));
  });

  it("sharedWorktreeBoard resolves a RELATIVE gitdir against the worktree", () => {
    // git can write a relative gitdir (extensions.relativeWorktrees); resolve it against the worktree.
    const rel = join(tmp, "rel-wt");
    mkdirSync(rel, { recursive: true });
    writeFileSync(join(rel, ".git"), "gitdir: ../repo/.git/worktrees/feat\n");
    assert.equal(sharedWorktreeBoard(rel), resolve(main, "data", "tasks.db"));
  });

  it("sharedWorktreeBoard returns null for a non-git directory", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    assert.equal(sharedWorktreeBoard(plain), null);
  });

  // Direct calls (not via defaultDbPath) so the .git-DIRECTORY branch has teeth: through defaultDbPath
  // the main-worktree case is indistinguishable from the per-dir fallthrough (both yield the same path).
  it("sharedWorktreeBoard maps a linked worktree (.git file) to the MAIN board", () => {
    assert.equal(sharedWorktreeBoard(linked), resolve(main, "data", "tasks.db"));
  });

  it("sharedWorktreeBoard maps a main worktree (.git dir) to its OWN board (not null)", () => {
    assert.equal(sharedWorktreeBoard(main), resolve(main, "data", "tasks.db"));
  });

  it("sharedWorktreeBoard tolerates a CRLF .git pointer (Windows git)", () => {
    const crlf = join(tmp, "repo-crlf");
    mkdirSync(crlf, { recursive: true });
    const gitdir = join(main, ".git", "worktrees", "feat").replace(/\\/g, "/");
    writeFileSync(join(crlf, ".git"), `gitdir: ${gitdir}\r\n`);
    assert.equal(sharedWorktreeBoard(crlf), resolve(main, "data", "tasks.db"));
  });
});
