import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { defaultConfig } from "../src/config.ts";
import type { RuntimeContext, RuntimeSnapshot } from "../src/runtime.ts";
import { initialTuiState, reduceTuiState } from "../src/state.ts";
import { createTuiLayout, runTui, updateTuiLayout } from "../src/tui.ts";
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

test("model options refresh when load state changes without changing keys", async () => {
  const { renderer } = await createTestRenderer({ width: 90, height: 24 });
  try {
    const layout = createTuiLayout(renderer);
    const snapshot = runtimeSnapshot([kimiModel()]);
    const state = reduceTuiState(initialTuiState(), {
      type: "refresh-succeeded",
      snapshot,
    });

    updateTuiLayout(layout, state, defaultConfig(), false);
    expect(layout.models.options[0]?.name).toStartWith("○");

    const loadedSnapshot = runtimeSnapshot([
      kimiModel({
        loadedInstances: [{ id: "kimi-loaded", contextLength: 65_536 }],
      }),
    ]);
    const loadedState = reduceTuiState(state, {
      type: "models-updated",
      snapshot: loadedSnapshot,
      message: "loaded",
    });
    updateTuiLayout(layout, loadedState, defaultConfig(), false);

    expect(layout.models.options[0]?.name).toStartWith("●");
  } finally {
    renderer.destroy();
  }
});

test("diagnostics use the highlighted model and can scroll to every check", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 110,
    height: 30,
  });
  try {
    const layout = createTuiLayout(renderer);
    const first = kimiModel({
      key: "test/first",
      displayName: "First model",
      loadedInstances: [{ id: "first-loaded", contextLength: 65_536 }],
    });
    const second = kimiModel({
      key: "test/second",
      displayName: "Highlighted model",
      capabilities: {
        vision: false,
        trainedForToolUse: false,
        reasoning: null,
      },
    });
    const refreshed = reduceTuiState(initialTuiState("test/first"), {
      type: "refresh-succeeded",
      snapshot: runtimeSnapshot([first, second]),
    });
    const selected = reduceTuiState(refreshed, {
      type: "selected",
      modelKey: "test/second",
    });

    updateTuiLayout(layout, selected, { ...defaultConfig(), selectedModel: "test/first" }, true);
    await renderOnce();
    layout.detailsBox.scrollTo(10_000);
    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("Highlighted model is not trained for tool use");
    expect(frame).toContain("Highlighted model is not loaded at 65,536 tokens");
    expect(frame).toContain("Memory: 64 GiB total");
  } finally {
    renderer.destroy();
  }
});

test("quit cancels refresh and waits for renderer teardown", async () => {
  const { renderer } = await createTestRenderer({ width: 90, height: 24 });
  const originalDestroy = renderer.destroy.bind(renderer);
  let destroyCalls = 0;
  renderer.destroy = () => {
    destroyCalls += 1;
  };
  let signal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  try {
    const resultPromise = runTui(defaultConfig(), "/tmp/config.json", {
      createRenderer: async () => renderer,
      collect: async (_config, options) => {
        signal = options?.signal;
        markStarted?.();
        return await new Promise<RuntimeContext>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      },
    });
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    await started;
    renderer.keyInput.emit("keypress", { name: "q", ctrl: false } as KeyEvent);
    await Bun.sleep(0);

    expect(signal?.aborted).toBe(true);
    expect(destroyCalls).toBe(1);
    expect(resolved).toBe(false);

    renderer.emit("destroy");
    expect(await resultPromise).toEqual({ kind: "quit" });
  } finally {
    renderer.destroy = originalDestroy;
    originalDestroy();
  }
});

test("launch continues when saving the model preference fails", async () => {
  const { renderer } = await createTestRenderer({ width: 90, height: 24 });
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const model = kimiModel();
  try {
    const resultPromise = runTui(defaultConfig(), "/read-only/config.json", {
      createRenderer: async () => renderer,
      collect: async () => {
        markReady?.();
        return {
          snapshot: runtimeSnapshot([model]),
          client: {} as RuntimeContext["client"],
        };
      },
      ensureLoaded: async () => ({
        instanceId: "loaded-instance",
        models: [
          kimiModel({
            loadedInstances: [{ id: "loaded-instance", contextLength: 65_536 }],
          }),
        ],
        reloaded: false,
      }),
      saveSelection: async () => {
        throw new Error("read-only");
      },
    });

    await ready;
    await Bun.sleep(0);
    renderer.keyInput.emit("keypress", { name: "c", ctrl: false } as KeyEvent);

    expect(await resultPromise).toEqual({
      kind: "launch",
      codexPath: "/usr/local/bin/codex",
      modelId: "loaded-instance",
      endpoint: "http://127.0.0.1:1234",
    });
  } finally {
    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
  }
});

function runtimeSnapshot(models: RuntimeSnapshot["models"]): RuntimeSnapshot {
  return {
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
    models,
  };
}
