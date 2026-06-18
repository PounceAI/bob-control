import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOpenTasks } from "./db.js";
import { TASK_STATUSES, isFinished } from "./types.js";
import type { Task, TaskStatus } from "./types.js";

// Minimal Task with a chosen status; the other fields don't affect selectOpenTasks unless overridden.
function task(id: number, status: TaskStatus, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    description: null,
    status,
    priority: "medium",
    tags: [],
    mode: null,
    assignee: null,
    result: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    depends_on: [],
    retry_attempts: 0,
    estimated_tokens: null,
    ...over,
  };
}

const LIVE_STATUSES: TaskStatus[] = ["staged", "pending", "in_progress", "needs_input", "blocked"];
const TERMINAL_STATUSES: TaskStatus[] = ["analysis_done", "done", "cancelled"];

test("LIVE/TERMINAL fixtures classify every status (a new unclassified status fails loudly)", () => {
  // Adding a status to TASK_STATUSES breaks this until it's deliberately bucketed, so the live/terminal
  // split below can't silently rubber-stamp whatever isFinished happens to do with it.
  assert.deepEqual([...TASK_STATUSES].sort(), [...LIVE_STATUSES, ...TERMINAL_STATUSES].sort());
  for (const s of LIVE_STATUSES) assert.equal(isFinished(s), false, `${s} should be live`);
  for (const s of TERMINAL_STATUSES) assert.equal(isFinished(s), true, `${s} should be terminal`);
});

test("selectOpenTasks keeps the live statuses and drops the finished ones", () => {
  const tasks = TASK_STATUSES.map((s, i) => task(i + 1, s));
  const { open_tasks, truncated } = selectOpenTasks(tasks, 50);
  assert.deepEqual(open_tasks.map((t) => t.status).sort(), [...LIVE_STATUSES].sort());
  assert.equal(truncated, false);
});

test("selectOpenTasks projects only the compact dedup fields and copies tags (no aliasing)", () => {
  const source = task(7, "pending", {
    tags: ["code-review", "review"],
    mode: "review",
    priority: "high",
    description: "heavy",
    result: "heavy",
  });
  const { open_tasks } = selectOpenTasks([source], 50);
  assert.deepEqual(open_tasks[0], {
    id: 7,
    title: "task 7",
    status: "pending",
    mode: "review",
    tags: ["code-review", "review"],
    priority: "high",
  });
  assert.deepEqual(Object.keys(open_tasks[0]).sort(), ["id", "mode", "priority", "status", "tags", "title"]);
  // Mutating the returned row's tags must not corrupt the source Task.
  open_tasks[0].tags.push("mutated");
  assert.deepEqual(source.tags, ["code-review", "review"]);
});

test("selectOpenTasks excludes terminals before the cap, not after", () => {
  // 4 live interleaved with 2 terminal, cap 3 → 3 live kept, no terminal leaks in, truncated (4 live > 3).
  const r = selectOpenTasks(
    [
      task(1, "pending"),
      task(2, "done"),
      task(3, "pending"),
      task(4, "cancelled"),
      task(5, "pending"),
      task(6, "pending"),
    ],
    3,
  );
  assert.equal(r.open_tasks.length, 3);
  assert.ok(
    r.open_tasks.every((t) => t.status === "pending"),
    "no terminal task leaked into the cap",
  );
  assert.equal(r.truncated, true);

  // Exactly cap live → full, not truncated.
  const exact = selectOpenTasks([task(1, "pending"), task(2, "pending"), task(3, "pending")], 3);
  assert.equal(exact.open_tasks.length, 3);
  assert.equal(exact.truncated, false);
});

test("selectOpenTasks keeps the most recently created tasks when it must truncate", () => {
  // listTasks hands us oldest-first; a just-filed duplicate is newest, so truncation must keep newest.
  const tasks = [
    task(1, "pending", { created_at: "2026-01-01T00:00:00.000Z" }),
    task(2, "pending", { created_at: "2026-01-02T00:00:00.000Z" }),
    task(3, "pending", { created_at: "2026-01-03T00:00:00.000Z" }),
  ];
  const { open_tasks, truncated } = selectOpenTasks(tasks, 2);
  assert.equal(truncated, true);
  assert.deepEqual(
    open_tasks.map((t) => t.id).sort((a, b) => a - b),
    [2, 3],
    "kept the two newest (ids 2,3), dropped the oldest (id 1)",
  );
});
