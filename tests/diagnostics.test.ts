import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { diagnose, toolCompatibilityCheck } from "../src/diagnostics.ts";
import type { RuntimeSnapshot } from "../src/runtime.ts";
import { kimiModel } from "./fixtures.ts";

describe("diagnostics", () => {
  test("does not claim inventory state while the server is offline", () => {
    const snapshot: RuntimeSnapshot = {
      system: {
        platform: "darwin",
        arch: "arm64",
        hostname: "mac",
        cpu: "Apple",
        totalMemoryBytes: 64 * 1024 ** 3,
        freeMemoryBytes: null,
        cwd: "/project",
      },
      codexPath: "/bin/codex",
      route: null,
      attempts: [
        {
          kind: "mac-local",
          endpoint: "http://127.0.0.1:1234",
          auth: "unknown",
          ok: false,
          errorKind: "host",
          message: "offline",
          fix: "start it",
        },
      ],
      models: [],
    };
    const inventory = diagnose(snapshot, defaultConfig()).find(
      (check) => check.name === "LLM inventory",
    );
    expect(inventory).toEqual(
      expect.objectContaining({
        level: "warn",
        detail: "Not checked because the LM Studio API is unavailable.",
      }),
    );
  });

  test("warns instead of blocking when tool compatibility is poor", () => {
    expect(
      toolCompatibilityCheck(
        kimiModel({
          capabilities: {
            vision: false,
            trainedForToolUse: false,
            reasoning: null,
          },
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        level: "warn",
        detail: expect.stringContaining("may be unreliable"),
      }),
    );
  });

  test("checks context against the selected model instead of any installed model", () => {
    const short = kimiModel({
      key: "test/short",
      displayName: "Short model",
      maxContextLength: 32_768,
    });
    const long = kimiModel({ key: "test/long", displayName: "Long model" });
    const checks = diagnose(onlineSnapshot([short, long]), {
      ...defaultConfig(),
      selectedModel: short.key,
    });

    expect(checks.find((check) => check.name === "Context")).toEqual(
      expect.objectContaining({
        level: "fail",
        detail: "Short model supports 32,768 tokens, not 65,536.",
      }),
    );
    expect(checks.find((check) => check.name === "Selected load")).toBeUndefined();
  });

  test("surfaces a failed direct-LAN fallback behind a reachable local endpoint", () => {
    const snapshot = onlineSnapshot([]);
    snapshot.system.platform = "win32";
    snapshot.system.arch = "x64";
    snapshot.route = {
      kind: "windows-lmlink",
      endpoint: "http://127.0.0.1:1234",
      device: "LM Link preferred device (API identity unavailable)",
      auth: "not-required",
    };
    snapshot.attempts = [
      {
        kind: "windows-lmlink",
        endpoint: "http://127.0.0.1:1234",
        auth: "not-required",
        ok: true,
      },
      {
        kind: "windows-lan",
        endpoint: "http://macbook.local:1234",
        auth: "missing",
        ok: false,
        errorKind: "authentication",
        message: "Direct-LAN access requires an API token.",
        fix: "Set LM_API_TOKEN in this shell.",
      },
    ];

    expect(diagnose(snapshot, defaultConfig())).toContainEqual(
      expect.objectContaining({
        name: "Direct LAN fallback",
        level: "fail",
        fix: "Set LM_API_TOKEN in this shell.",
      }),
    );
  });
});

function onlineSnapshot(models: RuntimeSnapshot["models"]): RuntimeSnapshot {
  return {
    system: {
      platform: "darwin",
      arch: "arm64",
      hostname: "mac",
      cpu: "Apple",
      totalMemoryBytes: 64 * 1024 ** 3,
      freeMemoryBytes: null,
      cwd: "/project",
    },
    codexPath: "/bin/codex",
    route: {
      kind: "mac-local",
      endpoint: "http://127.0.0.1:1234",
      device: "mac",
      auth: "not-required",
    },
    attempts: [],
    models,
  };
}
