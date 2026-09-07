#!/usr/bin/env node
// Bob `PreToolUse` hook on execute_command: a command the policy (command-policy.ts) denies exits 2 with the
// reason on stderr, which Bob shows the model. Allowed and unrecognised commands pass — auto-approve would run
// them anyway, so this only removes dangerous commands. Flags: --deny a,b  --allow x,y (extra prefixes).
import { evaluateCommand } from "./command-policy.js";

const COMMAND_TOOL = /^(execute_command|run_command)$/;

function csv(argv: string[], flag: string): string[] {
  const i = argv.indexOf(flag);
  return i === -1 || !argv[i + 1]
    ? []
    : argv[i + 1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

async function main(): Promise<number> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    input = JSON.parse(raw);
  } catch {
    return 0;
  }
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const command = (input.tool_input as { command?: unknown } | undefined)?.command;
  if (!COMMAND_TOOL.test(tool) || typeof command !== "string" || !command.trim()) return 0;
  const argv = process.argv.slice(2);
  const verdict = evaluateCommand(command, {
    deny: csv(argv, "--deny"),
    allow: csv(argv, "--allow"),
    repoRoot: typeof input.cwd === "string" ? input.cwd : undefined,
  });
  if (verdict.decision !== "deny") return 0;
  process.stderr.write(`bob-control command policy blocked this command (${verdict.reason}): ${command}\n`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0), // a broken hook must fail open, not wedge Bob
);
