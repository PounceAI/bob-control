#!/usr/bin/env node
// Bob `Stop` hook: writes the completion marker the in-process driver polls for (hooks.ts) from the
// `{session_id, cwd, last_assistant_message}` Bob pipes on stdin. Always exits 0; runs once per Bob turn.
import { stopMarkerDir, writeStopMarker } from "./hooks.js";

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: { session_id?: unknown; cwd?: unknown; last_assistant_message?: unknown };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof input.session_id !== "string" || !input.session_id) return;
  writeStopMarker(stopMarkerDir(), {
    session_id: input.session_id,
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    last_assistant_message: typeof input.last_assistant_message === "string" ? input.last_assistant_message : null,
  });
}

main().catch(() => {
  /* never fail the hook */
});
