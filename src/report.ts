import type { Task, TaskNote, TaskStatus } from "./types.js";

// An in_progress task whose updated_at is older than this is flagged as stalled.
const STALLED_MS = 30 * 60_000;

// Estimated cost per classifier decision (approve/deny) in USD
const CLASSIFIER_COST_PER_DECISION = 0.10;

interface AuditCounts {
  classifierApprove: number;
  classifierDeny: number;
  answererAnswer: number;
  answererEscalate: number;
  humanAnswer: number;
}

// Status groups in display order: most actionable first.
const GROUP_ORDER: TaskStatus[] = [
  "needs_input",
  "in_progress",
  "blocked",
  "pending",
  "staged",
  "analysis_done",
  "done",
  "cancelled",
];

const LABELS: Record<TaskStatus, string> = {
  staged: "Staged (not released)",
  pending: "Pending",
  in_progress: "In progress",
  needs_input: "❓ Awaiting answer",
  blocked: "Blocked",
  analysis_done: "Analysis done (no verified code)",
  done: "Done",
  cancelled: "Cancelled",
};

export interface ReportOptions {
  /** Restrict the report to a single status group. */
  status?: TaskStatus;
  /** Override the stalled threshold (ms) for in_progress tasks. */
  stalledMs?: number;
  /** Cap the number of tasks shown per TERMINAL group (done, cancelled). */
  limit?: number;
  /** Open question per task id, so needs_input rows show the actual question (not the last note). */
  openQuestions?: Map<number, { text: string; options: string[] }>;
}

/**
 * Count autonomous-decision activity from a task's notes. Pure function that
 * analyzes note authors and content to extract classifier, answerer, and human
 * answer-back activity.
 */
function countAuditActivity(notes: TaskNote[]): AuditCounts {
  const counts: AuditCounts = {
    classifierApprove: 0,
    classifierDeny: 0,
    answererAnswer: 0,
    answererEscalate: 0,
    humanAnswer: 0,
  };

  for (const note of notes) {
    if (note.author === "classifier") {
      // Classifier notes contain "approve" or "deny" in the text
      if (/\bapprove\b/i.test(note.note)) {
        counts.classifierApprove++;
      } else if (/\bdeny\b/i.test(note.note)) {
        counts.classifierDeny++;
      }
    } else if (note.author === "answerer") {
      // Answerer notes: "Answered" = auto-answer, "escalated" = escalation
      if (/\bAnswered\b/.test(note.note)) {
        counts.answererAnswer++;
      } else if (/\bescalated\b/i.test(note.note)) {
        counts.answererEscalate++;
      }
    } else if (note.author === "human") {
      // Human answer-back notes
      counts.humanAnswer++;
    }
  }

  return counts;
}

/**
 * Format audit counts into a compact one-line summary. Returns empty string if
 * no autonomous activity occurred.
 */
function formatAuditSummary(counts: AuditCounts): string {
  const parts: string[] = [];

  if (counts.classifierApprove > 0 || counts.classifierDeny > 0) {
    parts.push(`classifier: ${counts.classifierApprove}✓/${counts.classifierDeny}✗`);
  }

  if (counts.answererAnswer > 0 || counts.answererEscalate > 0) {
    parts.push(`answerer: ${counts.answererAnswer}✓/${counts.answererEscalate}⤴`);
  }

  if (counts.humanAnswer > 0) {
    parts.push(`human: ${counts.humanAnswer}✓`);
  }

  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
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

  // Accumulate board-level audit totals
  const boardAudit: AuditCounts = {
    classifierApprove: 0,
    classifierDeny: 0,
    answererAnswer: 0,
    answererEscalate: 0,
    humanAnswer: 0,
  };

  for (const status of groups) {
    const inGroup = tasks.filter((t) => t.status === status);
    total += inGroup.length;
    out.push(`## ${LABELS[status]} (${inGroup.length})`, "");
    if (!inGroup.length) {
      out.push("_none_", "");
      continue;
    }
    // Cap only the terminal groups (done, cancelled) so a long history doesn't bury
    // active work; in_progress/blocked/pending are never truncated.
    // Cap only true history (done/cancelled); analysis_done is actionable backlog, don't truncate it.
    const isTerminal = status === "done" || status === "cancelled";
    const cap = isTerminal && opts.limit && inGroup.length > opts.limit ? opts.limit : undefined;
    const shown = cap ? inGroup.slice(0, cap) : inGroup;
    for (const t of shown) {
      const notes = notesByTask.get(t.id) ?? [];
      const audit = countAuditActivity(notes);
      // Accumulate into board totals
      boardAudit.classifierApprove += audit.classifierApprove;
      boardAudit.classifierDeny += audit.classifierDeny;
      boardAudit.answererAnswer += audit.answererAnswer;
      boardAudit.answererEscalate += audit.answererEscalate;
      boardAudit.humanAnswer += audit.humanAnswer;
      out.push(taskLine(t, notes, now, stalledMs, audit, opts.openQuestions?.get(t.id)));
    }
    if (cap) out.push(`_… and ${inGroup.length - cap} more_`);
    out.push("");
  }

  // Add board-level audit summary if there's any autonomous activity
  const totalDecisions = boardAudit.classifierApprove + boardAudit.classifierDeny;
  if (totalDecisions > 0 || boardAudit.answererAnswer > 0 || boardAudit.answererEscalate > 0 || boardAudit.humanAnswer > 0) {
    out.push("## Autonomous Activity Summary", "");
    if (totalDecisions > 0) {
      const estimatedCost = (totalDecisions * CLASSIFIER_COST_PER_DECISION).toFixed(2);
      out.push(`- **Classifier**: ${boardAudit.classifierApprove} approved, ${boardAudit.classifierDeny} denied (~$${estimatedCost} estimated)`);
    }
    if (boardAudit.answererAnswer > 0 || boardAudit.answererEscalate > 0) {
      out.push(`- **Answerer**: ${boardAudit.answererAnswer} answered, ${boardAudit.answererEscalate} escalated`);
    }
    if (boardAudit.humanAnswer > 0) {
      out.push(`- **Human**: ${boardAudit.humanAnswer} answer${boardAudit.humanAnswer === 1 ? "" : "s"}`);
    }
    out.push("");
  }

  out.push(`_${total} task${total === 1 ? "" : "s"} · generated ${new Date(now).toISOString()}_`);
  return out.join("\n");
}

function taskLine(
  t: Task,
  notes: TaskNote[],
  now: number,
  stalledMs: number,
  audit?: AuditCounts,
  openQuestion?: { text: string; options: string[] },
): string {
  const meta = [t.priority, t.assignee && `@${t.assignee}`, t.mode && `{${t.mode}}`].filter(Boolean).join(" ");
  const idleMs = now - Date.parse(t.updated_at);
  const stalled = t.status === "in_progress" && idleMs >= stalledMs ? " ⚠ stalled" : "";
  // For an awaiting-answer task show the actual open question (authoritative) rather than
  // whatever note happens to be last; fall back to the last note otherwise.
  let tail: string;
  if (openQuestion) {
    const opts = openQuestion.options.length ? ` [${openQuestion.options.join(" | ")}]` : "";
    tail = ` — ❓ ${oneLine(openQuestion.text)}${opts}`;
  } else {
    const last = notes.at(-1);
    tail = last ? ` — ${last.author ? `${last.author}: ` : ""}${oneLine(last.note)}` : "";
  }
  const auditSummary = audit ? formatAuditSummary(audit) : "";
  return `- **#${t.id}** ${t.title} (${meta}) · age ${humanize(now - Date.parse(t.created_at))} · idle ${humanize(idleMs)}${stalled}${auditSummary}${tail}`;
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
