import type { TaskPriority } from "./types.js";

/** Named presets bundling a Bob mode, priority, tags, and a description scaffold. CLI flags override the template. */
export interface Template {
  name: string;
  about: string;
  mode: string;
  priority: TaskPriority;
  tags: string[];
  scaffold: (subject: string) => string;
}

export const TEMPLATES: Template[] = [
  {
    name: "bug-fix",
    about: "Reproduce and fix a defect, with a regression check",
    mode: "code",
    priority: "high",
    tags: ["bug"],
    scaffold: (s) =>
      [
        `Fix: ${s}`,
        "",
        "Steps:",
        "1. Reproduce the issue and identify the root cause.",
        "2. Apply the minimal fix.",
        "3. Add or update a test that fails before and passes after.",
        "",
        "Acceptance: the bug no longer reproduces and existing tests still pass.",
      ].join("\n"),
  },
  {
    name: "feature",
    about: "Implement a new capability end-to-end",
    mode: "code",
    priority: "medium",
    tags: ["feature"],
    scaffold: (s) =>
      [
        `Implement: ${s}`,
        "",
        "Include: implementation, edge-case handling, and tests.",
        "Acceptance: the feature works as described and the build passes.",
      ].join("\n"),
  },
  {
    name: "research",
    about: "Read-only investigation; produce findings, change nothing",
    mode: "ask",
    priority: "medium",
    tags: ["research"],
    scaffold: (s) =>
      [
        `Research question: ${s}`,
        "",
        "Investigate and summarize findings with concrete references.",
        "Do NOT modify any files — this is analysis only.",
      ].join("\n"),
  },
  {
    name: "code-review",
    about: "Review code for correctness and quality (read-only)",
    mode: "ask",
    priority: "medium",
    tags: ["review"],
    scaffold: (s) =>
      [
        `Review: ${s}`,
        "",
        "Assess correctness, edge cases, readability, and possible simplifications.",
        "Report findings as a prioritized list. Do not change code.",
      ].join("\n"),
  },
  {
    name: "doc",
    about: "Write or update documentation",
    mode: "code",
    priority: "low",
    tags: ["docs"],
    scaffold: (s) =>
      [
        `Document: ${s}`,
        "",
        "Produce clear, accurate documentation with examples where useful.",
      ].join("\n"),
  },
  {
    name: "refactor",
    about: "Restructure code without changing behavior",
    mode: "code",
    priority: "medium",
    tags: ["refactor"],
    scaffold: (s) =>
      [
        `Refactor: ${s}`,
        "",
        "Improve structure/clarity while preserving behavior.",
        "Acceptance: no behavior change; build and tests stay green.",
      ].join("\n"),
  },
];

export function getTemplate(name: string): Template | undefined {
  return TEMPLATES.find((t) => t.name === name.toLowerCase());
}
