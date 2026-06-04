import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReviewFindings, parseReviewFindings, type ReviewIssue } from "./review-findings.js";

test("formatReviewFindings guards a non-array / empty input", () => {
  assert.equal(formatReviewFindings([]), "## Review Findings\n\n(no findings)");
  // @ts-expect-error — exercising the runtime guard against malformed input
  assert.equal(formatReviewFindings(null), "## Review Findings\n\n(no findings)");
});

test("formatReviewFindings skips malformed issue entries", () => {
  const issues = [
    null,
    { title: "Real", severity: "low", category: "style", description: "ok" },
  ] as unknown as ReviewIssue[];
  const md = formatReviewFindings(issues);
  assert.ok(md.includes("### LOW: Real"));
  assert.ok(!md.includes("null"));
});

test("formatReviewFindings tolerates a missing severity/category", () => {
  const md = formatReviewFindings([{ title: "No sev", description: "d" } as unknown as ReviewIssue]);
  assert.ok(md.includes("### INFO: No sev"));
  assert.ok(md.includes("**Category:** general"));
});

test("parseReviewFindings returns [] when there are no sections", () => {
  assert.deepEqual(parseReviewFindings("just prose, no headings"), []);
  assert.deepEqual(parseReviewFindings(""), []);
});

test("parseReviewFindings recovers severity, location, category, fix", () => {
  const md = [
    "## Review Findings",
    "",
    "### HIGH: Race condition in git operations",
    "**Location:** src/judge.ts:176-189",
    "**Category:** correctness",
    "",
    "The finally block leaves the index dirty.",
    "",
    "**Suggested Fix:**",
    "```diff",
    "- await runGit(args, cwd);",
    "+ await runGit(args, cwd).catch(() => {});",
    "```",
  ].join("\n");
  const [issue] = parseReviewFindings(md);
  assert.equal(issue.severity, "high");
  assert.equal(issue.title, "Race condition in git operations");
  assert.equal(issue.file, "src/judge.ts");
  assert.equal(issue.line, 176); // first int of a 176-189 range
  assert.equal(issue.category, "correctness");
  assert.equal(issue.description, "The finally block leaves the index dirty.");
  assert.ok(issue.fixed_diff?.includes("catch(() => {})"));
  assert.ok(!issue.fixed_diff?.includes("```"));
});

test("parseReviewFindings handles a section with no severity prefix or fix", () => {
  const md = [
    "### Some general note about the design",
    "**Location:** src/worker.ts",
    "**Category:** design",
    "",
    "Consider extracting this.",
  ].join("\n");
  const [issue] = parseReviewFindings(md);
  assert.equal(issue.severity, "info");
  assert.equal(issue.title, "Some general note about the design");
  assert.equal(issue.file, "src/worker.ts");
  assert.equal(issue.line, undefined);
  assert.equal(issue.fixed_diff, undefined);
  assert.equal(issue.description, "Consider extracting this.");
});

test("parseReviewFindings recovers an inline 'Severity:' heading suffix", () => {
  // The shape Bob emitted on a real run: severity in the heading, not leading.
  const md = ["### Critical Bug - Severity: HIGH", "**Location:** sum.ts:2", "Uninitialized variable causes NaN."].join(
    "\n",
  );
  const [issue] = parseReviewFindings(md);
  assert.equal(issue.severity, "high");
  assert.equal(issue.title, "Critical Bug");
  assert.equal(issue.file, "sum.ts");
  assert.equal(issue.line, 2);
});

test("parseReviewFindings recovers a body-level '**Severity:**' line", () => {
  const md = ["### Some issue", "**Severity:** medium", "**Category:** perf", "desc"].join("\n");
  const [issue] = parseReviewFindings(md);
  assert.equal(issue.severity, "medium");
  assert.equal(issue.title, "Some issue");
  assert.ok(!issue.description.includes("Severity"));
});

test("parseReviewFindings parses multiple findings", () => {
  const md = [
    "### HIGH: First",
    "**Category:** correctness",
    "desc one",
    "",
    "### LOW: Second",
    "**Category:** style",
    "desc two",
  ].join("\n");
  const issues = parseReviewFindings(md);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].title, "First");
  assert.equal(issues[1].severity, "low");
  assert.equal(issues[1].description, "desc two");
});

test("format -> parse round-trips the structured fields", () => {
  const original: ReviewIssue[] = [
    {
      title: "SQL injection risk",
      description: "Unsanitized user input in query",
      file: "src/db.ts",
      line: 42,
      severity: "high",
      category: "security",
      fixed_diff: "- q(input)\n+ q(escape(input))",
    },
  ];
  const round = parseReviewFindings(formatReviewFindings(original));
  assert.equal(round.length, 1);
  assert.equal(round[0].title, original[0].title);
  assert.equal(round[0].severity, original[0].severity);
  assert.equal(round[0].file, original[0].file);
  assert.equal(round[0].line, original[0].line);
  assert.equal(round[0].category, original[0].category);
  assert.equal(round[0].description, original[0].description);
  assert.equal(round[0].fixed_diff, original[0].fixed_diff);
});

test("formatReviewFindings preserves line 0 (round-trips, not dropped as falsy)", () => {
  const md = formatReviewFindings([
    { title: "X", description: "d", file: "a.ts", line: 0, severity: "low", category: "general" },
  ]);
  assert.ok(md.includes("**Location:** a.ts:0"), "line 0 should appear in the location");
  const round = parseReviewFindings(md);
  assert.equal(round[0].file, "a.ts");
  assert.equal(round[0].line, 0);
});

test("parseReviewFindings ignores a '### ' heading inside a fenced diff (no spurious finding, fix intact)", () => {
  const md = [
    "### HIGH: Refactor the header",
    "**Location:** src/h.ts:3",
    "**Category:** style",
    "Tidy this up.",
    "",
    "**Suggested Fix:**",
    "```diff",
    "-### old heading",
    "+### new heading",
    "```",
  ].join("\n");
  const issues = parseReviewFindings(md);
  assert.equal(issues.length, 1, "the ### inside the diff must not split into a second finding");
  assert.equal(issues[0].title, "Refactor the header");
  assert.ok(issues[0].fixed_diff?.includes("+### new heading"), "the diff fix must survive intact");
});

// Made with Bob
