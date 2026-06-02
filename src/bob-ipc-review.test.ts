import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewIssue } from "./bob-ipc.js";
import { formatReviewFindings } from "./review-findings.js";

// Test the review findings capture and formatting logic.
// These tests verify that submit_review_findings tool calls are properly
// captured from the IPC stream and formatted as markdown for the board.

test("ReviewIssue interface accepts all required fields", () => {
  const issue: ReviewIssue = {
    title: "Potential SQL injection",
    description: "User input is concatenated directly into SQL query",
    file: "src/db.ts",
    line: 42,
    severity: "high",
    category: "security",
  };
  assert.equal(issue.title, "Potential SQL injection");
  assert.equal(issue.file, "src/db.ts");
  assert.equal(issue.line, 42);
});

test("ReviewIssue accepts filePath as alternative to file", () => {
  const issue: ReviewIssue = {
    title: "Missing error handling",
    description: "Promise rejection not caught",
    filePath: "src/api.ts",
    line: 100,
    severity: "medium",
    category: "reliability",
  };
  assert.equal(issue.filePath, "src/api.ts");
});

test("ReviewIssue accepts optional fixed_diff", () => {
  const issue: ReviewIssue = {
    title: "Use const instead of let",
    description: "Variable is never reassigned",
    file: "src/utils.ts",
    line: 10,
    severity: "low",
    category: "style",
    fixed_diff: `- let count = 0;
+ const count = 0;`,
  };
  assert.ok(issue.fixed_diff);
  assert.ok(issue.fixed_diff.includes("const"));
});

test("formatReviewFindings renders a single issue without fixed_diff", () => {
  const issues: ReviewIssue[] = [
    {
      title: "Missing null check",
      description: "Variable may be null at this point",
      file: "src/parser.ts",
      line: 55,
      severity: "medium",
      category: "reliability",
    },
  ];
  const markdown = formatReviewFindings(issues);
  assert.ok(markdown.includes("## Review Findings"));
  assert.ok(markdown.includes("### MEDIUM: Missing null check"));
  assert.ok(markdown.includes("**Location:** src/parser.ts:55"));
  assert.ok(markdown.includes("**Category:** reliability"));
  assert.ok(markdown.includes("Variable may be null at this point"));
  assert.ok(!markdown.includes("Suggested Fix"));
});

test("formatReviewFindings renders multiple issues", () => {
  const issues: ReviewIssue[] = [
    {
      title: "SQL injection risk",
      description: "Unsanitized user input in query",
      file: "src/db.ts",
      line: 42,
      severity: "high",
      category: "security",
    },
    {
      title: "Unused variable",
      description: "Variable declared but never used",
      file: "src/utils.ts",
      line: 10,
      severity: "low",
      category: "style",
    },
  ];
  const markdown = formatReviewFindings(issues);
  assert.ok(markdown.includes("### HIGH: SQL injection risk"));
  assert.ok(markdown.includes("### LOW: Unused variable"));
  assert.ok(markdown.includes("src/db.ts:42"));
  assert.ok(markdown.includes("src/utils.ts:10"));
});

test("formatReviewFindings includes fixed_diff when present", () => {
  const issues: ReviewIssue[] = [
    {
      title: "Use const instead of let",
      description: "Variable is never reassigned",
      file: "src/app.ts",
      line: 5,
      severity: "low",
      category: "style",
      fixed_diff: `- let count = 0;
+ const count = 0;`,
    },
  ];
  const markdown = formatReviewFindings(issues);
  assert.ok(markdown.includes("**Suggested Fix:**"));
  assert.ok(markdown.includes("```diff"));
  assert.ok(markdown.includes("- let count = 0;"));
  assert.ok(markdown.includes("+ const count = 0;"));
  assert.ok(markdown.includes("```"));
});

test("formatReviewFindings handles issue without line number", () => {
  const issues: ReviewIssue[] = [
    {
      title: "Missing documentation",
      description: "Public API lacks JSDoc comments",
      file: "src/api.ts",
      severity: "low",
      category: "documentation",
    },
  ];
  const markdown = formatReviewFindings(issues);
  assert.ok(markdown.includes("**Location:** src/api.ts"));
  // Should not have a line number suffix (no ":42" style)
  assert.ok(!markdown.includes("src/api.ts:"));
});

test("formatReviewFindings handles issue with filePath instead of file", () => {
  const issues: ReviewIssue[] = [
    {
      title: "Deprecated API usage",
      description: "Using deprecated method",
      filePath: "src/legacy.ts",
      line: 100,
      severity: "medium",
      category: "maintenance",
    },
  ];
  const markdown = formatReviewFindings(issues);
  assert.ok(markdown.includes("**Location:** src/legacy.ts:100"));
});

test("submit_review_findings payload structure", () => {
  // Simulate the tool call payload Bob sends
  const toolPayload = {
    tool: "submit_review_findings",
    issues: [
      {
        title: "Memory leak",
        description: "Event listener not removed",
        file: "src/events.ts",
        line: 25,
        severity: "high",
        category: "performance",
      },
      {
        title: "Typo in comment",
        description: "Should be 'receive' not 'recieve'",
        file: "src/handler.ts",
        line: 12,
        severity: "low",
        category: "documentation",
        fixed_diff: `- // recieve the message
+ // receive the message`,
      },
    ],
  };

  // Verify the structure matches what we expect to parse
  assert.equal(toolPayload.tool, "submit_review_findings");
  assert.ok(Array.isArray(toolPayload.issues));
  assert.equal(toolPayload.issues.length, 2);
  assert.equal(toolPayload.issues[0].title, "Memory leak");
  assert.equal(toolPayload.issues[1].fixed_diff?.includes("receive"), true);
});

// Made with Bob
