import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, createTask, recordArtifact, deleteTaskSafe, getTask } from "./db.js";

const DB = join(tmpdir(), "bob-test-delete.db");
function clean(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("delete safety (incident B)", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("refuses to delete a task with recorded artifacts (no force), warning about orphans", () => {
    const t = createTask({ title: "ran and wrote a file" });
    recordArtifact(t.id, { kind: "file", path: "/tmp/EMBEDDING_MIGRATION_PLAN.md" });
    const r = deleteTaskSafe(t.id);
    assert.equal(r.deleted, false);
    assert.match(r.warning ?? "", /not undo|artifact/i);
    assert.match(r.warning ?? "", /EMBEDDING_MIGRATION_PLAN/);
    assert.ok(getTask(t.id)); // record survives
  });

  it("force deletes the record despite artifacts", () => {
    const t = createTask({ title: "ran" });
    recordArtifact(t.id, { kind: "file", path: "/tmp/x.md" });
    const r = deleteTaskSafe(t.id, { force: true });
    assert.equal(r.deleted, true);
    assert.equal(getTask(t.id), null);
  });

  it("cleanup unlinks the orphaned files, then deletes", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-art-"));
    const f = join(dir, "PLAN.md");
    writeFileSync(f, "orphan");
    const t = createTask({ title: "ran and wrote" });
    recordArtifact(t.id, { kind: "file", path: f });

    const r = deleteTaskSafe(t.id, { cleanup: true });
    assert.equal(r.deleted, true);
    assert.deepEqual(r.cleaned, [f]);
    assert.equal(existsSync(f), false);
  });

  it("a task with no artifacts deletes as before", () => {
    const t = createTask({ title: "no side effects" });
    assert.equal(deleteTaskSafe(t.id).deleted, true);
    assert.equal(getTask(t.id), null);
  });
});
