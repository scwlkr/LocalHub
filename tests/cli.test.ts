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

test("CLI rejects a clipped terminal before entering alternate-screen mode", async () => {
  let tuiRuns = 0;
  const result = await captureErrors(() =>
    main([], {
      arch: "arm64",
      configFile: "/test/config.json",
      interactive: true,
      load: async () => defaultConfig(),
      platform: "darwin",
      runInteractive: async () => {
        tuiRuns += 1;
        return { kind: "quit" };
      },
      terminalColumns: 80,
      terminalRows: 12,
    }),
  );

  expect(result.code).toBe(2);
  expect(tuiRuns).toBe(0);
  expect(result.errors).toEqual([
    "Terminal too small (80x12). LocalHub needs at least 80x18.",
    "Fix: enlarge the terminal and rerun `lh`; use `lh status` meanwhile.",
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

test("setup keeps a direct-LAN token process-scoped through TUI and Codex", async () => {
  const config = {
    ...defaultConfig(),
    lanEndpoint: "http://studio-mac.local:1234",
    selectedModel: "catalog/model-key",
  };
  let tuiToken: string | undefined;
  let childToken: string | undefined;

  const code = await main(["setup"], {
    arch: "x64",
    configFile: "C:\\config.json",
    env: { SAFE_PARENT_VALUE: "kept" },
    interactive: true,
    load: async () => defaultConfig(),
    platform: "win32",
    runSetupWizard: async () => ({
      kind: "configured",
      route: "lan",
      config,
      sessionToken: "session-secret",
      ready: true,
      launch: true,
    }),
    runInteractive: async (_config, _path, dependencies) => {
      tuiToken = dependencies?.env?.LM_API_TOKEN;
      if (!tuiToken) {
        throw new Error("Expected a setup-session token.");
      }
      return {
        kind: "launch",
        codexPath: "C:\\bin\\codex.exe",
        modelId: "loaded-instance",
        endpoint: "http://studio-mac.local:1234",
        token: tuiToken,
      };
    },
    runLocalCodex: async (spec) => {
      childToken = spec.env.LOCALHUB_LMSTUDIO_TOKEN;
      expect(spec.env.LM_API_TOKEN).toBeUndefined();
      expect(spec.env.SAFE_PARENT_VALUE).toBe("kept");
      return 0;
    },
  });

  expect(code).toBe(0);
  expect(tuiToken).toBe("session-secret");
  expect(childToken).toBe("session-secret");
  expect(process.env.LOCALHUB_LMSTUDIO_TOKEN).toBeUndefined();
});

test("setup reports an unfinished Windows route without opening the TUI", async () => {
  let tuiRuns = 0;
  const code = await main(["setup"], {
    arch: "x64",
    configFile: "C:\\config.json",
    interactive: true,
    load: async () => defaultConfig(),
    platform: "win32",
    runSetupWizard: async () => ({
      kind: "incomplete",
      route: "lmlink",
      config: defaultConfig(),
      ready: false,
      launch: false,
    }),
    runInteractive: async () => {
      tuiRuns += 1;
      return { kind: "quit" };
    },
  });

  expect(code).toBe(1);
  expect(tuiRuns).toBe(0);
});

test("interactive Windows launch asks for a configured fallback token only when needed", async () => {
  let prompt = "";
  let tuiToken: string | undefined;
  const code = await main([], {
    arch: "x64",
    collect: async () => ({
      snapshot: {
        system: {
          platform: "win32",
          arch: "x64",
          hostname: "windows",
          cpu: "test",
          totalMemoryBytes: 16_000,
          freeMemoryBytes: 8_000,
          cwd: "C:\\project",
        },
        codexPath: "C:\\bin\\codex.exe",
        route: null,
        attempts: [
          {
            kind: "windows-lan",
            endpoint: "http://studio-mac.local:1234",
            auth: "missing",
            ok: false,
          },
        ],
        models: [],
      },
      client: null,
    }),
    configFile: "C:\\config.json",
    env: {},
    interactive: true,
    load: async () => ({
      ...defaultConfig(),
      lanEndpoint: "http://studio-mac.local:1234",
    }),
    platform: "win32",
    readSecret: async (value) => {
      prompt = value;
      return "prompted-secret";
    },
    runInteractive: async (_config, _path, dependencies) => {
      tuiToken = dependencies?.env?.LM_API_TOKEN;
      return { kind: "quit" };
    },
  });

  expect(code).toBe(0);
  expect(prompt).toBe("Direct-LAN token for studio-mac.local");
  expect(tuiToken).toBe("prompted-secret");
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
