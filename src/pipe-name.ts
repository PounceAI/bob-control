import { createHash } from "node:crypto";
import { win32 as winPath } from "node:path";

/**
 * Canonical form of a workspace path for identity: collapse `.`/`..`/dup separators (win32 semantics,
 * so tests run cross-platform), then case/separator-fold for Windows' case-insensitive paths. The ONE
 * normalization both the pipe-name hash and the layer-2 workspace guard key off, so "same folder" means
 * the same thing in both places. Throws on a blank path (a launcher/worker must pass a real one).
 */
export function normalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath?.trim();
  if (!trimmed) throw new Error("normalizeWorkspacePath: workspacePath is required");
  return winPath.normalize(trimmed).toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Do two paths denote the same workspace folder? The worker's layer-2 guard compares Bob's reported
 * open folder to its own cwd with this. Blank/garbage on either side → not equal, so an unknown path
 * can never read as a false match.
 */
export function sameWorkspace(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

/**
 * Per-instance IPC pipe name for a Bob window, from its workspace path: each worktree gets a DISTINCT,
 * stable name so concurrent Bobs don't collide on one global pipe (the cross-fire bug). Pass an absolute
 * path; it's canonicalized (see normalizeWorkspacePath) so one folder → one name. Returns the raw
 * `\\.\pipe\bob-ipc-<slug>` (node-ipc registers it doubled; open()'s retry connects). The one place the
 * slug is defined — launcher scripts call `tools/print-pipe-name.mjs`. slug = <sanitized basename>-<12
 * hex of the path>: basename for debugging, hash for distinctness.
 */
export function bobPipeName(workspacePath: string): string {
  const norm = normalizeWorkspacePath(workspacePath);
  const hash = createHash("sha256").update(norm).digest("hex").slice(0, 12);
  // Slice BEFORE trimming dashes so a 32-char cut landing on a separator can't leave a trailing dash.
  const base =
    (norm.split("/").pop() ?? "")
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 32)
      .replace(/^-+|-+$/g, "") || "ws";
  return `\\\\.\\pipe\\bob-ipc-${base}-${hash}`;
}
