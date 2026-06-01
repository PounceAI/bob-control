import type { Task, TaskNote, TaskStatus } from "./types.js";

// An in_progress task whose updated_at is older than this is flagged as stalled.
const STALLED_MS = 30 * 60_000;

// Status groups in display order: most actionable first.
const GROUP_ORDER: TaskStatus[] = ["in_progress", "blocked", "pending", "done", "cancelled"];

const LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export interface ReportOptions {
  /** Restrict the report to a single status group. */
  status?: TaskStatus;
  /** Override the stalled threshold (ms) for in_progress tasks. */
  stalledMs?: number;
}

/**
 * Render the board as a markdown standup/audit. Pure: pass `now` (epoch ms) and the
 * data — no DB or IO — so the output is deterministic and unit-testable. `tasks` is
 * assumed to already be in pull order (priority desc, then oldest), as
 * repo.listTasks returns it; grouping by status preserves that order.
 */
export function buildReport(
  tasks: Task[],
  notesByTask: Map<number, TaskNote[]>,
  now: number,
  opts: ReportOptions = {},
): string {
  const stalledMs = opts.stalledMs ?? STALLED_MS;
  const groups = opts.status ? [opts.status] : GROUP_ORDER;

  const out: string[] = ["# Board report", ""];
  let total = 0;
  for (const status of groups) {
    const inGroup = tasks.filter((t) => t.status === status);
    total += inGroup.length;
    out.push(`## ${LABELS[status]} (${inGroup.length})`, "");
    if (!inGroup.length) {
      out.push("_none_", "");
      continue;
    }
    for (const t of inGroup) out.push(taskLine(t, notesByTask.get(t.id) ?? [], now, stalledMs));
    out.push("");
  }
  out.push(`_${total} task${total === 1 ? "" : "s"} · generated ${new Date(now).toISOString()}_`);
  return out.join("\n");
}

function taskLine(t: Task, notes: TaskNote[], now: number, stalledMs: number): string {
  const meta = [t.priority, t.assignee && `@${t.assignee}`, t.mode && `{${t.mode}}`].filter(Boolean).join(" ");
  const idleMs = now - Date.parse(t.updated_at);
  const stalled = t.status === "in_progress" && idleMs >= stalledMs ? " ⚠ stalled" : "";
  const last = notes.at(-1);
  const note = last ? ` — ${last.author ? `${last.author}: ` : ""}${oneLine(last.note)}` : "";
  return `- **#${t.id}** ${t.title} (${meta}) · age ${humanize(now - Date.parse(t.created_at))} · idle ${humanize(idleMs)}${stalled}${note}`;
}

/** Coarse duration: seconds, minutes, hours, or days. Clamps negatives/NaN to 0. */
function humanize(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
}
