import { test } from "node:test";
import assert from "node:assert/strict";
import { createBob2Host, BOB2_EXTENSION_ID, type VscodeBob2Deps } from "./bob2-host.js";
import { isBob2Window } from "./bob2-driver.js";

// The production Bob2Host adapter over a fake vscode surface — exports resolution, workspace folder
// reporting, and that it composes with the driver's capability detection.

function deps(over: Partial<VscodeBob2Deps> & { exports?: unknown; folder?: string | null } = {}): VscodeBob2Deps {
  return {
    getExtension:
      over.getExtension ?? ((id) => (id === BOB2_EXTENSION_ID ? { isActive: true, exports: over.exports } : undefined)),
    workspaceFolders:
      over.workspaceFolders ?? (() => (over.folder == null ? undefined : [{ uri: { fsPath: over.folder } }])),
  };
}

test("exports() returns Bob's exports when present, null when absent or not yet activated", () => {
  const ex = { startTask: () => {} };
  assert.equal(createBob2Host(deps({ exports: ex })).exports(), ex); // present → the same exports object
  assert.equal(createBob2Host(deps({ getExtension: () => undefined })).exports(), null); // extension absent
  assert.equal(createBob2Host(deps({ exports: undefined })).exports(), null); // present but not yet activated
});

test("the host composes with isBob2Window: true only with a callable startTask", () => {
  assert.equal(isBob2Window(createBob2Host(deps({ exports: { startTask: () => {} } }))), true);
  assert.equal(isBob2Window(createBob2Host(deps({ exports: {} }))), false); // exports present, no startTask
  assert.equal(isBob2Window(createBob2Host(deps({ getExtension: () => undefined }))), false);
});

test("workspaceFolder() returns the first folder's fsPath, null when none/blank", () => {
  assert.equal(createBob2Host(deps({ folder: "C:/wt/a" })).workspaceFolder(), "C:/wt/a");
  assert.equal(createBob2Host(deps({ folder: null })).workspaceFolder(), null);
  assert.equal(createBob2Host(deps({ folder: "   " })).workspaceFolder(), null);
});

test("uses the configured extension id", () => {
  const seen: string[] = [];
  const host = createBob2Host(
    { getExtension: (id) => (seen.push(id), undefined), workspaceFolders: () => undefined },
    "Custom.bob",
  );
  host.exports();
  assert.deepEqual(seen, ["Custom.bob"]);
});
