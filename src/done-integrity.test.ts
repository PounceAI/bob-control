import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, createTask, completeTask, getNotes, recordArtifact, hasEvidence } from "./db.js";

const DB = join(tmpdir(), "bob-test-done.db");
function clean(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("done-integrity gate", () => {
  before(() => {
    process.env.BOB_TASKS_DB = DB;
    clean();
    getDb();
  });
  after(clean);

  it("a read-only run terminates as analysis_done, never done", () => {
    const t = createTask({ title: "Analyze the auth flow", mode: "ask" });
    const done = completeTask(t.id, { result: "findings…", ranReadOnly: true });
    assert.equal(done?.status, "analysis_done");
  });

  it("an implementation run with NO evidence lands in analysis_done + a note", () => {
    const t = createTask({ title: "Implement X", mode: "code" });
    const done = completeTask(t.id, { result: "I did it", ranReadOnly: false });
    assert.equal(done?.status, "analysis_done");
    assert.ok(getNotes(t.id).some((n) => /without execution evidence/i.test(n.note)));
  });

  it("an implementation run WITH evidence reaches done and records artifacts", () => {
    const t = createTask({ title: "Implement Y", mode: "code" });
    const done = completeTask(t.id, {
      result: "done",
      ranReadOnly: false,
      evidence: { files: ["/tmp/y.ts"], files_changed: 1, test: "npm test: ok" },
    });
    assert.equal(done?.status, "done");
    assert.equal(hasEvidence(t.id), true);
  });

  it("pre-recorded artifacts count as evidence for done", () => {
    const t = createTask({ title: "Implement Z", mode: "code" });
    recordArtifact(t.id, { kind: "file", path: "/tmp/z.ts" });
    const done = completeTask(t.id, { result: "done", ranReadOnly: false });
    assert.equal(done?.status, "done");
  });

  it("a read-only 'side-effect' file artifact does NOT count as implementation evidence", () => {
    const t = createTask({ title: "Implement W", mode: "code" });
    // A file recorded as a read-only side-effect must not satisfy the done gate.
    recordArtifact(t.id, { kind: "file", path: "/tmp/w.log", detail: "side-effect" });
    assert.equal(hasEvidence(t.id), false);
    const done = completeTask(t.id, { result: "done", ranReadOnly: false });
    assert.equal(done?.status, "analysis_done");
  });

  it("an implementation with no evidence reaches done (UNVERIFIED) when evidence is NOT reliably checkable", () => {
    const t = createTask({ title: "Implement V in a non-git dir", mode: "code" });
    const done = completeTask(t.id, { result: "did it", ranReadOnly: false, evidenceReliable: false });
    assert.equal(done?.status, "done"); // fail-open: don't mismark real work as analysis_done
    assert.ok(getNotes(t.id).some((n) => /could not be captured|UNVERIFIED/i.test(n.note)));
  });
});
