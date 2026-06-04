import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCheckpoint, restoreCheckpoint, revertTaskToCheckpoint, deleteTaskAndCheckpoint } from "./checkpoint.js";
import { snapshotWorktreeTree } from "./git.js";
import { getDb, createTask, setCheckpoint, getCheckpoint, clearCheckpoint, getNotes, recordArtifact } from "./db.js";

function git(dir: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bob-ckpt-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}
function commit(dir: string, file: string, content: string, msg = "c"): void {
  writeFileSync(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
}
function refPresent(dir: string, ref: string): boolean {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: dir }).status === 0;
}
const rm = (d: string) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

describe("checkpoint capture + restore (real git)", () => {
  it("restore reverts modified, removes created files + emptied dirs, keeps pre-existing untracked, HEAD unchanged", async () => {
    const dir = makeRepo();
    commit(dir, "tracked.txt", "v1");
    writeFileSync(join(dir, "keep.txt"), "pre-existing"); // untracked before capture
    const headBefore = git(dir, "rev-parse", "HEAD");

    const cp = (await captureCheckpoint(dir, 1))!;
    assert.ok(cp);
    assert.equal(cp.ref, "refs/bob/checkpoint/1");

    writeFileSync(join(dir, "tracked.txt"), "v2-broken");
    writeFileSync(join(dir, "new.txt"), "junk");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "added.txt"), "x");
    git(dir, "add", "sub/added.txt"); // created + staged (tracked)

    const r = await restoreCheckpoint(dir, cp);
    assert.equal(r.reverted, true);
    assert.equal(readFileSync(join(dir, "tracked.txt"), "utf8"), "v1");
    assert.equal(existsSync(join(dir, "new.txt")), false);
    assert.equal(existsSync(join(dir, "sub", "added.txt")), false);
    assert.equal(existsSync(join(dir, "sub")), false, "emptied dir pruned");
    assert.equal(existsSync(join(dir, "keep.txt")), true, "pre-existing untracked preserved");
    assert.equal(git(dir, "rev-parse", "HEAD"), headBefore, "HEAD did not move");
    rm(dir);
  });

  it("restores a pre-task uncommitted edit (dirty baseline) and survives git gc (pinned ref)", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    writeFileSync(join(dir, "f.txt"), "v1-dirty"); // uncommitted pre-task edit
    const cp = (await captureCheckpoint(dir, 7))!;

    git(dir, "gc", "--prune=now"); // would prune a dangling stash commit — the pin keeps it
    writeFileSync(join(dir, "f.txt"), "v2");

    const r = await restoreCheckpoint(dir, cp);
    assert.equal(r.reverted, true, "restore succeeds after gc thanks to the pinned ref");
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "v1-dirty");
    rm(dir);
  });

  it("removes a task-created file with a non-ASCII name", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    const cp = (await captureCheckpoint(dir, 2))!;
    writeFileSync(join(dir, "späcial.txt"), "junk");
    const r = await restoreCheckpoint(dir, cp);
    assert.equal(r.reverted, true);
    assert.equal(existsSync(join(dir, "späcial.txt")), false, "non-ASCII created file removed");
    rm(dir);
  });

  it("REFUSES (no destruction) when run in a different repo than the checkpoint", async () => {
    const a = makeRepo();
    commit(a, "f.txt", "v1");
    const cp = (await captureCheckpoint(a, 1))!;
    const b = makeRepo();
    commit(b, "b.txt", "B");
    writeFileSync(join(b, "junkB.txt"), "important new file in B");

    const r = await restoreCheckpoint(b, cp);
    assert.equal(r.reverted, false);
    assert.match(r.note, /wrong repo/i);
    assert.equal(existsSync(join(b, "junkB.txt")), true, "B's untracked file NOT deleted");
    assert.equal(readFileSync(join(b, "b.txt"), "utf8"), "B", "B's tracked file untouched");
    rm(a);
    rm(b);
  });

  it("REFUSES when the snapshot ref is gone (does not delete created files)", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    writeFileSync(join(dir, "f.txt"), "dirty"); // dirty → snapshot is a pinned stash commit
    const cp = (await captureCheckpoint(dir, 1))!;
    git(dir, "update-ref", "-d", cp.ref); // snapshot ref deleted
    git(dir, "gc", "--prune=now");
    writeFileSync(join(dir, "created.txt"), "should survive a refused revert");

    const r = await restoreCheckpoint(dir, cp);
    assert.equal(r.reverted, false);
    assert.match(r.note, /missing|refus/i);
    assert.equal(existsSync(join(dir, "created.txt")), true, "nothing deleted on a refused revert");
    rm(dir);
  });

  it("REFUSES when HEAD moved since capture, unless forced (and never moves HEAD)", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    const cp = (await captureCheckpoint(dir, 1))!; // clean capture at v1
    commit(dir, "f.txt", "v2", "second"); // HEAD advances
    const v2head = git(dir, "rev-parse", "HEAD");

    const refused = await restoreCheckpoint(dir, cp);
    assert.equal(refused.reverted, false);
    assert.match(refused.note, /HEAD moved/i);

    const forced = await restoreCheckpoint(dir, cp, { force: true });
    assert.equal(forced.reverted, true);
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "v1", "worktree restored to snapshot");
    assert.equal(git(dir, "rev-parse", "HEAD"), v2head, "HEAD still at v2 — not orphaned");
    rm(dir);
  });

  it("pins the pre-revert state to a recoverable recovery ref", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    const cp = (await captureCheckpoint(dir, 1))!;
    writeFileSync(join(dir, "f.txt"), "v2-broken-but-wanted");

    const r = await restoreCheckpoint(dir, cp);
    assert.equal(r.reverted, true);
    assert.ok(r.recoveryRef && /^refs\/bob\/recovery\//.test(r.recoveryRef), "recovery ref recorded");
    // The discarded work is recoverable from that ref.
    assert.equal(git(dir, "show", `${r.recoveryRef}:f.txt`), "v2-broken-but-wanted");
    rm(dir);
  });

  it("recovery ref captures an UNTRACKED created file (stash create would have dropped it)", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    const cp = (await captureCheckpoint(dir, 1))!;
    // The task's ONLY change is a brand-new untracked file — the regression case: `git stash
    // create` ignores untracked files, so the pre-fix recovery ref captured nothing here.
    mkdirSync(join(dir, "created"));
    writeFileSync(join(dir, "created", "work.txt"), "valuable new work");

    const r = await restoreCheckpoint(dir, cp);
    assert.equal(r.reverted, true);
    assert.equal(existsSync(join(dir, "created", "work.txt")), false, "created file removed by revert");
    assert.ok(
      r.recoveryRef && /^refs\/bob\/recovery\//.test(r.recoveryRef),
      "recovery ref recorded even for an untracked-only change",
    );
    // The discarded new file is fully recoverable from that ref.
    assert.equal(git(dir, "show", `${r.recoveryRef}:created/work.txt`), "valuable new work");
    rm(dir);
  });

  it("snapshotWorktreeTree captures untracked + tracked changes without touching the real index", async () => {
    const dir = makeRepo();
    commit(dir, "tracked.txt", "v1"); // index now matches HEAD at v1
    writeFileSync(join(dir, "tracked.txt"), "v2"); // tracked modification (unstaged)
    writeFileSync(join(dir, "untracked.txt"), "new"); // untracked addition

    const tree = await snapshotWorktreeTree(dir);
    assert.ok(tree && /^[0-9a-f]{40}$/.test(tree), "returns a tree sha");
    assert.equal(git(dir, "show", `${tree}:tracked.txt`), "v2", "tracked modification captured");
    assert.equal(git(dir, "show", `${tree}:untracked.txt`), "new", "untracked file captured");
    // The real index is untouched — tracked.txt is still staged at v1, not the worktree's v2.
    assert.equal(git(dir, "show", ":tracked.txt"), "v1", "real index not modified by the temp-index snapshot");
    // The throwaway temp index (and its lock) is cleaned up, not leaked into the git dir.
    assert.equal(
      readdirSync(join(dir, ".git")).filter((f) => f.startsWith("bob-tmp-index")).length,
      0,
      "no temp index/lock leaked",
    );
    rm(dir);
  });
});

describe("checkpoint orchestration + persistence (db)", () => {
  const dbDir = mkdtempSync(join(tmpdir(), "bob-ckpt-db-"));
  before(() => {
    process.env.BOB_TASKS_DB = join(dbDir, "tasks.db");
    getDb();
  });
  after(() => {
    delete process.env.BOB_TASKS_DB;
    rm(dbDir);
  });

  it("setCheckpoint / getCheckpoint round-trips (with root); clearCheckpoint drops it", () => {
    const t = createTask({ title: "ckpt" });
    assert.equal(getCheckpoint(t.id), null);
    const cp = { root: "/r", head: "abc", ref: "refs/bob/checkpoint/1", untracked: ["a.txt"] };
    setCheckpoint(t.id, cp);
    assert.deepEqual(getCheckpoint(t.id), cp);
    clearCheckpoint(t.id);
    assert.equal(getCheckpoint(t.id), null);
  });

  it("revertTaskToCheckpoint reverts, records a note, and consumes the checkpoint", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    const t = createTask({ title: "real revert" });
    setCheckpoint(t.id, (await captureCheckpoint(dir, t.id))!);
    writeFileSync(join(dir, "f.txt"), "v2");
    writeFileSync(join(dir, "junk.txt"), "x");

    const r = await revertTaskToCheckpoint(dir, t.id, "test");
    assert.ok(r?.reverted);
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "v1");
    assert.equal(existsSync(join(dir, "junk.txt")), false);
    assert.equal(getCheckpoint(t.id), null, "checkpoint consumed after revert");
    assert.ok(getNotes(t.id).some((n) => /Checkpoint rollback/.test(n.note)));
    rm(dir);
  });

  it("revertTaskToCheckpoint returns null when the task has no checkpoint", async () => {
    const dir = makeRepo();
    const t = createTask({ title: "no ckpt" });
    assert.equal(await revertTaskToCheckpoint(dir, t.id, "test"), null);
    rm(dir);
  });

  it("revertTaskToCheckpoint reverts the captured repo even when called from an unrelated cwd", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    const t = createTask({ title: "cwd-independent revert" });
    setCheckpoint(t.id, (await captureCheckpoint(dir, t.id))!);
    writeFileSync(join(dir, "f.txt"), "v2");
    const elsewhere = makeRepo(); // a different repo as the caller's cwd — must be ignored
    const r = await revertTaskToCheckpoint(elsewhere, t.id, "test");
    assert.ok(r?.reverted, "reverted via cp.root, not the caller's cwd");
    assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "v1");
    rm(dir);
    rm(elsewhere);
  });

  it("deleteTaskAndCheckpoint drops the checkpoint pin ref (no leak)", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    writeFileSync(join(dir, "f.txt"), "dirty"); // dirty → pin points at a real stash commit
    const t = createTask({ title: "del+ref" });
    const cp = (await captureCheckpoint(dir, t.id))!;
    setCheckpoint(t.id, cp);
    assert.equal(cp.ref, `refs/bob/checkpoint/${t.id}`);
    assert.ok(refPresent(dir, cp.ref), "pin ref exists before delete");

    const r = await deleteTaskAndCheckpoint(t.id);
    assert.equal(r.deleted, true);
    assert.equal(refPresent(dir, cp.ref), false, "pin ref removed after delete");
    rm(dir);
  });

  it("deleteTaskAndCheckpoint keeps the pin ref when the delete is refused (artifacts, no force)", async () => {
    const dir = makeRepo();
    commit(dir, "f.txt", "v1");
    writeFileSync(join(dir, "f.txt"), "dirty");
    const t = createTask({ title: "refused del" });
    const cp = (await captureCheckpoint(dir, t.id))!;
    setCheckpoint(t.id, cp);
    recordArtifact(t.id, { kind: "file", path: join(dir, "f.txt"), detail: "created" }); // makes delete refuse

    const r = await deleteTaskAndCheckpoint(t.id); // no force → refused
    assert.equal(r.deleted, false);
    assert.ok(refPresent(dir, cp.ref), "pin ref preserved when delete is refused");
    rm(dir);
  });

  it("getCheckpoint rejects a checkpoint whose untracked has non-string entries", () => {
    const t = createTask({ title: "bad-untracked" });
    getDb()
      .prepare("UPDATE tasks SET checkpoint = ? WHERE id = ?")
      .run(
        JSON.stringify({ root: "/r", head: "abc", ref: "refs/bob/checkpoint/1", untracked: ["ok.txt", 123, null] }),
        t.id,
      );
    assert.equal(getCheckpoint(t.id), null, "non-string untracked entry → treated as no checkpoint");
  });
});
