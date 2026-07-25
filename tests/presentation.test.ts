import { describe, expect, test } from "bun:test";
import { renderModelDetails, renderStatus } from "../src/presentation.ts";
import type { RuntimeSnapshot } from "../src/runtime.ts";
import type { ModelInfo } from "../src/types.ts";

const model: ModelInfo = {
  type: "llm",
  publisher: "example",
  key: "example/model",
  displayName: "Example Model",
  architecture: "example-moe",
  quantization: { name: "6bit", bitsPerWeight: 6 },
  sizeBytes: 29_100_000_000,
  paramsString: "35B-A3B",
  loadedInstances: [{ id: "example/model", contextLength: 258_816, parallel: 1 }],
  maxContextLength: 262_144,
  format: "mlx",
  capabilities: {
    vision: true,
    trainedForToolUse: true,
    reasoning: { allowedOptions: ["off", "on"], default: "on" },
  },
  description: null,
  variants: ["example/model@6bit"],
  selectedVariant: "example/model@6bit",
};

const snapshot: RuntimeSnapshot = {
  system: {
    platform: "darwin",
    arch: "arm64",
    hostname: "studio-mac",
    cpu: "Apple",
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
  models: [model],
};

describe("model presentation", () => {
  test("shows the selected variant and reasoning default in TUI details", () => {
    const details = renderModelDetails(model);

    expect(details).toContain("Variant: example/model@6bit");
    expect(details).toContain("example/model @ 258,816 · parallel 1");
    expect(details).toContain("reasoning off/on (default on)");
  });

  test("shows the selected variant, format, and reasoning default in status", () => {
    const status = renderStatus(
      snapshot,
      {
        contextLength: 65_536,
        localEndpoint: "http://127.0.0.1:1234",
        tokenEnv: "LM_API_TOKEN",
        selectedModel: model.key,
      },
      "/config.json",
    );

    expect(status).toContain("variant=example/model@6bit · format=mlx");
    expect(status).toContain("loaded=example/model@258,816/p1");
    expect(status).toContain("reasoning=off/on (default on)");
  });
});
