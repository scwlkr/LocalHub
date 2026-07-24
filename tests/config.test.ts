import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  configPath,
  defaultConfig,
  loadConfig,
  parseConfig,
  saveConfig,
  saveSelectedModel,
} from "../src/config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("configuration", () => {
  test("uses platform-standard user paths", () => {
    expect(configPath("darwin", {}, "/Users/test")).toBe(
      "/Users/test/Library/Application Support/LocalHub/config.json",
    );
    expect(configPath("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "ignored")).toBe(
      "C:\\Users\\test\\AppData\\Roaming\\LocalHub\\config.json",
    );
    expect(configPath("darwin", { XDG_CONFIG_HOME: "/custom" }, "/Users/test")).toBe(
      "/custom/localhub/config.json",
    );
  });

  test("defaults to a 65,536-token local route", () => {
    expect(defaultConfig()).toEqual({
      contextLength: 65_536,
      localEndpoint: "http://127.0.0.1:1234",
      tokenEnv: "LM_API_TOKEN",
    });
  });

  test("validates and normalizes non-secret settings", () => {
    expect(
      parseConfig({
        contextLength: 131_072,
        localEndpoint: "http://localhost:1234/",
        lanEndpoint: "https://macbook.local:1234",
        tokenEnv: "MY_LM_TOKEN",
        selectedModel: "runtime/model-id",
      }),
    ).toEqual({
      contextLength: 131_072,
      localEndpoint: "http://localhost:1234",
      lanEndpoint: "https://macbook.local:1234",
      tokenEnv: "MY_LM_TOKEN",
      selectedModel: "runtime/model-id",
    });
  });

  test("rejects credentials and secret-shaped unknown fields", () => {
    expect(() => parseConfig({ localEndpoint: "http://user:pass@localhost:1234" })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ token: "do-not-store-me" })).toThrow(
      'Unknown configuration key "token"',
    );
  });

  test("loads defaults when no file exists and atomically saves selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "localhub-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "config.json");

    const config = await loadConfig(path);
    expect(config.contextLength).toBe(65_536);
    await saveSelectedModel("catalog/runtime-kimi-3-q4", config, path);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...config,
      selectedModel: "catalog/runtime-kimi-3-q4",
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("atomically saves a complete non-secret wizard configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "localhub-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");

    await saveConfig(
      {
        contextLength: 65_536,
        localEndpoint: "http://127.0.0.1:1234",
        lanEndpoint: "http://studio-mac.local:1234",
        tokenEnv: "LOCALHUB_SESSION_TOKEN",
        selectedModel: "catalog/model-key",
      },
      path,
    );

    expect(await loadConfig(path)).toEqual({
      contextLength: 65_536,
      localEndpoint: "http://127.0.0.1:1234",
      lanEndpoint: "http://studio-mac.local:1234",
      tokenEnv: "LOCALHUB_SESSION_TOKEN",
      selectedModel: "catalog/model-key",
    });
  });
});
