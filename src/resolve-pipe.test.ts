import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePipe } from "./bob-ipc.js";

// Pins resolvePipe's precedence (arg › BOB_IPC_PIPE › ROO_CODE_IPC_SOCKET_PATH › legacy default) and
// its blank-is-unset rule. withEnv() restores the env on every path so these cases — which set ambient
// pipe vars — can't leak into other suites (e.g. a later no-arg BobClient() hitting a live host pipe).

const LEGACY = "\\\\.\\pipe\\pipe\\bob-ipc";
const PIPE_KEYS = ["BOB_IPC_PIPE", "ROO_CODE_IPC_SOCKET_PATH"] as const;
type PipeKey = (typeof PIPE_KEYS)[number];

/** Run `fn` with the given pipe env vars set (undefined = deleted), then restore the prior values. */
function withEnv(vars: Partial<Record<PipeKey, string | undefined>>, fn: () => void): void {
  const saved = PIPE_KEYS.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of PIPE_KEYS) {
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("explicit arg wins over every env var", () => {
  withEnv({ BOB_IPC_PIPE: "\\\\.\\pipe\\env", ROO_CODE_IPC_SOCKET_PATH: "\\\\.\\pipe\\roo" }, () => {
    assert.equal(resolvePipe("\\\\.\\pipe\\explicit"), "\\\\.\\pipe\\explicit");
  });
});

test("BOB_IPC_PIPE used when no arg, ahead of ROO_CODE_IPC_SOCKET_PATH", () => {
  withEnv({ BOB_IPC_PIPE: "\\\\.\\pipe\\bob", ROO_CODE_IPC_SOCKET_PATH: "\\\\.\\pipe\\roo" }, () => {
    assert.equal(resolvePipe(), "\\\\.\\pipe\\bob");
  });
});

test("ROO_CODE_IPC_SOCKET_PATH used when no arg and no BOB_IPC_PIPE (per-instance routing)", () => {
  withEnv({ BOB_IPC_PIPE: undefined, ROO_CODE_IPC_SOCKET_PATH: "\\\\.\\pipe\\roo" }, () => {
    assert.equal(resolvePipe(), "\\\\.\\pipe\\roo");
  });
});

test("legacy default when nothing is set", () => {
  withEnv({ BOB_IPC_PIPE: undefined, ROO_CODE_IPC_SOCKET_PATH: undefined }, () => {
    assert.equal(resolvePipe(), LEGACY);
  });
});

test('set-but-empty ROO_CODE_IPC_SOCKET_PATH falls through to the default, not ""', () => {
  withEnv({ BOB_IPC_PIPE: undefined, ROO_CODE_IPC_SOCKET_PATH: "" }, () => {
    assert.equal(resolvePipe(), LEGACY);
  });
});

test("set-but-empty BOB_IPC_PIPE falls through to ROO_CODE_IPC_SOCKET_PATH", () => {
  withEnv({ BOB_IPC_PIPE: "", ROO_CODE_IPC_SOCKET_PATH: "\\\\.\\pipe\\roo" }, () => {
    assert.equal(resolvePipe(), "\\\\.\\pipe\\roo");
  });
});

test("whitespace-only env value is treated as unset", () => {
  withEnv({ BOB_IPC_PIPE: "   ", ROO_CODE_IPC_SOCKET_PATH: undefined }, () => {
    assert.equal(resolvePipe(), LEGACY);
  });
});

test("empty/whitespace explicit arg falls through to env, then default", () => {
  withEnv({ BOB_IPC_PIPE: undefined, ROO_CODE_IPC_SOCKET_PATH: "\\\\.\\pipe\\roo" }, () => {
    assert.equal(resolvePipe(""), "\\\\.\\pipe\\roo");
    assert.equal(resolvePipe("   "), "\\\\.\\pipe\\roo");
  });
  withEnv({ BOB_IPC_PIPE: undefined, ROO_CODE_IPC_SOCKET_PATH: undefined }, () => {
    assert.equal(resolvePipe(""), LEGACY);
  });
});
