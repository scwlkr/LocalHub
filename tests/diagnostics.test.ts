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
});
