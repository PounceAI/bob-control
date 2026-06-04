// Review-findings (de)serialization shared by the worker.
//
// Two directions:
//  - formatReviewFindings: structured issues -> markdown for the board note.
//  - parseReviewFindings:   markdown review text -> structured issues.
//
// The parse direction exists because review mode is tool-restricted under headless
// IPC dispatch: Bob never calls submit_review_findings, it just returns the review
// as completion_result *text*. We recover structure from that text so the board
// still gets countable, formatted findings (see worker.ts).
import type { ReviewIssue } from "./bob-ipc.js";

export type { ReviewIssue };

/**
 * Format review findings as markdown for display in the task board.
 * Each issue gets a section with severity, file:line, title, description,
 * and an optional fenced fixed_diff. Defensive against malformed issues
 * (missing/oddly-typed fields) since findings may come from a text parser,
 * not just the structured submit_review_findings tool.
 */
export function formatReviewFindings(issues: ReviewIssue[]): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "## Review Findings\n\n(no findings)";
  }
  const lines: string[] = ["## Review Findings", ""];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const severity = typeof issue.severity === "string" && issue.severity.trim() ? issue.severity : "info";
    lines.push(`### ${severity.toUpperCase()}: ${issue.title || "(untitled)"}`);
    const file = issue.file || issue.filePath;
    if (file) {
      // Number.isFinite (not a truthy check): a line of 0 is a valid line number and
      // must survive a format/parse round-trip — `issue.line ? …` would drop it.
      const location = Number.isFinite(issue.line) ? `${file}:${issue.line}` : file;
      lines.push(`**Location:** ${location}`);
    }
    lines.push(`**Category:** ${issue.category || "general"}`);
    lines.push("");
    lines.push(issue.description || "");
    if (issue.fixed_diff) {
      lines.push("");
      lines.push("**Suggested Fix:**");
      lines.push("```diff");
      lines.push(issue.fixed_diff);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Heading prefixes we recognize as a severity (Bob emits "### HIGH: title").
// Anything else in that slot is treated as part of the title.
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info", "warning", "minor", "major"]);

/** Pull a `**Label:** value` field out of a section body (first match wins). */
function field(body: string, label: string): string | undefined {
  const m = body.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i"));
  return m ? m[1].trim() : undefined;
}

/**
 * Split review text into section bodies on `### ` headings, IGNORING headings that
 * fall inside a fenced code block (``` or ~~~). A plain `text.split(/^###\s+/m)` is
 * fence-unaware, so a `### ` line inside a finding's ```diff fix (or quoted prose)
 * would spuriously start a new finding AND truncate that fix. Each returned string is
 * "<heading text>\n<body…>" — the `### ` prefix stripped — matching the old shape.
 */
function splitH3Sections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] | null = null;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^###\s+/.test(line)) {
      if (current) sections.push(current.join("\n"));
      current = [line.replace(/^###\s+/, "")];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join("\n"));
  return sections;
}

/**
 * Parse a markdown review (Bob's completion_result text) back into structured
 * issues — the inverse of formatReviewFindings, tolerant of the looser shape a
 * model emits. Splits on `### ` headings; for each, recovers severity/title from
 * the heading, **Location:** (file + optional first line number), **Category:**,
 * a fenced ```diff fixed_diff, and the remaining prose as the description.
 * Returns [] when no `### ` sections are present.
 */
export function parseReviewFindings(markdown: string): ReviewIssue[] {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const text = markdown.replace(/\r\n/g, "\n");
  // Each section runs from a `### ` heading to the next one (or end of text),
  // skipping headings inside fenced code blocks.
  const sections = splitH3Sections(text);
  const issues: ReviewIssue[] = [];

  for (const section of sections) {
    const nl = section.indexOf("\n");
    const heading = (nl === -1 ? section : section.slice(0, nl)).trim();
    const body = nl === -1 ? "" : section.slice(nl + 1);

    // Recover severity + title from the heading, tolerant of the two shapes a
    // model emits: a leading token ("HIGH: title") or an inline suffix
    // ("title - Severity: HIGH"). Falls back to a Severity: field in the body.
    let severity = "info";
    let title = heading;
    const sep = heading.indexOf(":");
    const leading = sep !== -1 ? heading.slice(0, sep).trim().toLowerCase() : "";
    const inline = heading.match(/^(.*?)[\s\-–(]*severity:?\s*(critical|high|medium|low|info|warning|minor|major)\b\)?\s*$/i);
    if (sep !== -1 && SEVERITIES.has(leading)) {
      severity = leading;
      title = heading.slice(sep + 1).trim();
    } else if (inline) {
      title = inline[1].replace(/[\s\-–]+$/, "").trim();
      severity = inline[2].toLowerCase();
    } else {
      // e.g. "**Severity:** HIGH", "**Severity**: high", or a bare "Severity: low".
      const sv = body.match(/severity\**:?\**\s*(critical|high|medium|low|info|warning|minor|major)\b/i);
      if (sv) severity = sv[1].toLowerCase();
    }
    if (!title) continue;

    const issue: ReviewIssue = {
      title,
      severity,
      category: field(body, "Category") ?? "general",
      description: "",
    };

    // Location: "path" or "path:line" or "path:start-end" (first int wins).
    const loc = field(body, "Location");
    if (loc) {
      const lm = loc.match(/^(.*?):(\d+)/);
      if (lm) {
        issue.file = lm[1].trim();
        issue.line = Number(lm[2]);
      } else {
        issue.file = loc;
      }
    }

    // Fenced ```diff ... ``` block becomes the suggested fix.
    const diff = body.match(/```diff\n([\s\S]*?)```/);
    if (diff) issue.fixed_diff = diff[1].replace(/\n$/, "");

    // Description: prose after the metadata, before the fix label / diff fence.
    const desc = body
      .replace(/\*\*(?:Location|Category|Severity):\*\*.*(?:\n|$)/gi, "")
      .replace(/\*\*Suggested Fix:\*\*/i, "")
      .replace(/```diff\n[\s\S]*?```/g, "")
      .trim();
    issue.description = desc;

    issues.push(issue);
  }

  return issues;
}
