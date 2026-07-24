import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { defaultConfig } from "../src/config.ts";

test("CLI turns renderer startup failures into a concise fix", async () => {
  const result = await captureErrors(() =>
    main([], {
      arch: "arm64",
      configFile: "/test/config.json",
      interactive: true,
      load: async () => defaultConfig(),
      platform: "darwin",
      runInteractive: async () => {
        throw new Error("native library unavailable");
      },
    }),
  );

  expect(result.code).toBe(1);
  expect(result.errors).toEqual([
    "LocalHub TUI failed: native library unavailable",
    "Fix: install the matching platform build and run `lh doctor`.",
  ]);
});

test("CLI turns a Codex spawn race into a concise dependency fix", async () => {
  const result = await captureErrors(() =>
    main([], {
      arch: "arm64",
      configFile: "/test/config.json",
      interactive: true,
      load: async () => defaultConfig(),
      platform: "darwin",
      runInteractive: async () => ({
        kind: "launch",
        codexPath: "/missing/codex",
        modelId: "loaded-instance",
        endpoint: "http://127.0.0.1:1234",
      }),
      runLocalCodex: async () => {
        throw new Error("ENOENT");
      },
    }),
  );

  expect(result.code).toBe(1);
  expect(result.errors).toEqual([
    "Codex failed to start: ENOENT",
    "Fix: reinstall Codex and confirm `codex --version` works in this shell.",
  ]);
});

async function captureErrors(run: () => Promise<number>): Promise<{
  code: number;
  errors: string[];
}> {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  };
  try {
    return { code: await run(), errors };
  } finally {
    console.error = original;
  }
}
