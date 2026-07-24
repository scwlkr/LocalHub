import { describe, expect, test } from "bun:test";
import type { RuntimeSnapshot } from "../src/runtime.ts";
import { initialTuiState, reduceTuiState } from "../src/state.ts";
import { qwenModel } from "./fixtures.ts";

const snapshot: RuntimeSnapshot = {
  system: {
    platform: "darwin",
    arch: "arm64",
    hostname: "mac",
    cpu: "Apple",
    totalMemoryBytes: 64,
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
  models: [qwenModel()],
};

describe("TUI state transitions", () => {
  test("refresh keeps a valid preference and reaches ready", () => {
    const state = reduceTuiState(initialTuiState("qwen/qwen3.6-35b-a3b"), {
      type: "refresh-succeeded",
      snapshot,
    });
    expect(state.phase).toBe("ready");
    expect(state.selectedModel).toBe("qwen/qwen3.6-35b-a3b");
    expect(state.operation).toBeNull();
  });

  test("falls back to the first runtime LLM when preference disappears", () => {
    const state = reduceTuiState(initialTuiState("missing"), {
      type: "refresh-succeeded",
      snapshot,
    });
    expect(state.selectedModel).toBe("qwen/qwen3.6-35b-a3b");
  });

  test("tracks operation and error state", () => {
    const ready = reduceTuiState(initialTuiState(), { type: "refresh-succeeded", snapshot });
    const busy = reduceTuiState(ready, {
      type: "operation-started",
      operation: "load",
      message: "Loading…",
    });
    expect(busy).toEqual(expect.objectContaining({ phase: "busy", operation: "load" }));
    expect(reduceTuiState(busy, { type: "failed", message: "failed" })).toEqual(
      expect.objectContaining({ phase: "error", operation: null, message: "failed" }),
    );
  });
});
