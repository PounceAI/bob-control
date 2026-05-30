import "./suppress-warnings.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

// Use a throwaway DB so the smoke test never touches the real store.
process.env.BOB_TASKS_DB = join(mkdtempSync(join(tmpdir(), "bob-tasks-")), "smoke.db");

const repo = await import("./db.js");

const created = repo.createTask({
  title: "Refactor INVRPT RPG program",
  description: "Split monolithic INVRPT into modular procedures.",
  priority: "high",
  tags: ["rpg", "refactor"],
});
assert.equal(created.status, "pending");
assert.deepEqual(created.tags, ["rpg", "refactor"]);

repo.createTask({ title: "Low priority cleanup", priority: "low" });

const next = repo.nextTask();
assert.equal(next?.id, created.id, "high priority should come first");

const claimed = repo.claimTask(created.id, "bob");
assert.equal(claimed?.status, "in_progress");
assert.equal(claimed?.assignee, "bob");

const note = repo.addNote(created.id, "Extracted CALC subprocedure.", "bob");
assert.ok(note);
assert.equal(repo.getNotes(created.id).length, 1);

const done = repo.setResult(created.id, "Refactor complete, 3 procedures extracted.");
assert.equal(done?.status, "done");

assert.equal(repo.listTasks({ status: "pending" }).length, 1);
assert.equal(repo.listTasks({ tag: "rpg" }).length, 1);

console.log("smoke: OK — created, prioritized, claimed, noted, completed, filtered");
