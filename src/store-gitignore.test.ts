import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "./db.js";

// getDb mkdir's dirname(DB) and writes a .gitignore there on first open.
const ROOT = mkdtempSync(join(tmpdir(), "bob-gi-"));
const DATA_DIR = join(ROOT, "data");
const DB = join(DATA_DIR, "tasks.db");

describe("store gitignore (incident D)", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    getDb();
  });
  after(() => {
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* WAL handle may still be open on Windows; tmpdir leftover is harmless */
    }
  });

  it("writes a .gitignore beside the board covering the db files", () => {
    const gi = join(DATA_DIR, ".gitignore");
    assert.ok(existsSync(gi), ".gitignore should exist next to the board");
    const txt = readFileSync(gi, "utf8");
    assert.match(txt, /^tasks\.db$/m);
    assert.match(txt, /^tasks\.db-wal$/m);
    assert.match(txt, /^tasks\.db-shm$/m);
  });
});
