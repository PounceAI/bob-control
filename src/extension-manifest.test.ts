import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Props = Record<string, { scope?: string }>;
const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "package.json"), "utf8"),
) as {
  capabilities?: { untrustedWorkspaces?: { supported?: boolean | string } };
  contributes: { configuration: { properties: Props } | { properties: Props }[] };
};

// Settings naming an executable or code to load must be user-level ("machine"): a window-scoped one can be set by
// a repo's .vscode/settings.json, which then picks what the extension runs.
const EXEC_SETTINGS = [
  "bobTasks.connectorPath",
  "bobTasks.nodePath",
  "bobTasks.classifierCliPath",
  "bobTasks.bobShellPath",
  "bobTasks.acpArgs",
];

test("executable and code-path settings are machine-scoped", () => {
  const props: Props = Object.assign({}, ...[manifest.contributes.configuration].flat().map((c) => c.properties));
  for (const k of EXEC_SETTINGS) assert.equal(props[k]?.scope, "machine", k);
});

test("the extension stays off in untrusted workspaces (connector auto-detect loads workspace code)", () => {
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
});
