import type { Bob2Host, Bob2StartTask } from "./bob2-driver.js";

// V5 tail: the production Bob2Host — the binding from the in-process driver's host seam to the real VS
// Code / Bob APIs. Kept out of bob2-driver.ts (which stays vscode-free and unit-testable) and built over
// an injected `vscode` surface, so it's testable with a fake and the extension passes the real module:
//   createBob2Host({ getExtension: (id) => vscode.extensions.getExtension(id),
//                     workspaceFolders: () => vscode.workspace.workspaceFolders })

/** The slice of the VS Code API the host needs. The extension supplies these from the real `vscode`. */
export interface VscodeBob2Deps {
  /** vscode.extensions.getExtension — resolves a sibling extension's activated exports. */
  getExtension(id: string): { isActive?: boolean; exports?: unknown } | undefined;
  /** vscode.workspace.workspaceFolders — the open folders (first one is the dispatch target). */
  workspaceFolders(): readonly { uri: { fsPath: string } }[] | undefined;
}

/** Bob 2.0's extension id — the sibling extension whose exported activate() API the driver calls. */
export const BOB2_EXTENSION_ID = "IBM.bob-code";

/**
 * Build a Bob2Host over the injected vscode surface. `exports()` returns Bob 2.0's exports only when the
 * extension is present (its activate() ran) — null otherwise, which is the negative signal isBob2Window /
 * selectDriver use to fall back to the 1.x pipe driver. `workspaceFolder()` is the first open folder's
 * fsPath (blank → null). Validating the exports shape is left to the driver (isBob2Window/connect), so
 * this stays a thin adapter with a single source of truth for "is this really a 2.0 surface".
 */
export function createBob2Host(deps: VscodeBob2Deps, extensionId = BOB2_EXTENSION_ID): Bob2Host {
  return {
    exports(): Bob2StartTask | null {
      const ext = deps.getExtension(extensionId);
      // exports is populated once the extension has activated; undefined before then or if absent.
      const ex = ext?.exports;
      return ex ? (ex as Bob2StartTask) : null;
    },
    workspaceFolder(): string | null {
      const fsPath = deps.workspaceFolders()?.[0]?.uri.fsPath;
      return fsPath && fsPath.trim() ? fsPath : null;
    },
  };
}
