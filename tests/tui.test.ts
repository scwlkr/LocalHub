import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { defaultConfig } from "../src/config.ts";
import type { RuntimeSnapshot } from "../src/runtime.ts";
import { initialTuiState, reduceTuiState } from "../src/state.ts";
import { createTuiLayout, updateTuiLayout } from "../src/tui.ts";
import { kimiModel } from "./fixtures.ts";

test("OpenTUI layout renders runtime Kimi details and all action hints", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 90,
    height: 24,
  });
  try {
    const layout = createTuiLayout(renderer);
    const snapshot: RuntimeSnapshot = {
      system: {
        platform: "darwin",
        arch: "arm64",
        hostname: "studio-mac",
        cpu: "Apple M-series",
        totalMemoryBytes: 64 * 1024 ** 3,
        freeMemoryBytes: null,
        cwd: "/project",
      },
      codexPath: "/usr/local/bin/codex",
      route: {
        kind: "mac-local",
        endpoint: "http://127.0.0.1:1234",
        device: "studio-mac",
        auth: "not-required",
      },
      attempts: [],
      models: [kimiModel()],
    };
    const state = reduceTuiState(initialTuiState(), {
      type: "refresh-succeeded",
      snapshot,
    });

    updateTuiLayout(layout, state, defaultConfig(), false);
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("Kimi 3");
    expect(frame).toContain("catalog/runtime-kimi-3-q4");
    expect(frame).toContain("65,536");
    expect(frame).toContain("load/reload");
    expect(frame).toContain("diagnostics");
  } finally {
    renderer.destroy();
  }
});
