#!/usr/bin/env bun

import { buildCodexProcess, runCodex } from "./codex.ts";
import { ConfigError, configPath, loadConfig, saveConfig } from "./config.ts";
import { diagnose } from "./diagnostics.ts";
import { renderDoctor, renderStatus } from "./presentation.ts";
import { collectRuntime } from "./runtime.ts";
import { readHiddenInput, runSetup, type SetupResult } from "./setup.ts";
import { runTui } from "./tui.ts";
import type { LocalHubConfig } from "./types.ts";

export const VERSION = "0.1.0";

const HELP = `LocalHub ${VERSION}

Usage:
  lh                 Open the model picker
  lh setup           Configure Windows access with a guided wizard
  lh status          Show system, route, server, and model state
  lh doctor          Check setup and print concise fixes
  lh --help          Show this help

TUI keys:
  ↑/↓ or j/k  select        l  load/reload at configured context
  Enter or c  launch Codex  u  unload selected model
  r           refresh       d  diagnostics
  q or Esc    quit

Configuration:
  macOS    ~/Library/Application Support/LocalHub/config.json
  Windows  %APPDATA%\\LocalHub\\config.json

API tokens are never stored. Windows setup and interactive launch can prompt
with hidden input; scripts may set tokenEnv (default: LM_API_TOKEN).
`;

export interface CliDependencies {
  arch?: string;
  collect?: typeof collectRuntime;
  configFile?: string;
  interactive?: boolean;
  load?: typeof loadConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runInteractive?: typeof runTui;
  runLocalCodex?: typeof runCodex;
  readSecret?: typeof readHiddenInput;
  runSetupWizard?: typeof runSetup;
  save?: typeof saveConfig;
}

export async function main(
  args = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const command = parseCommand(args);
  if (command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (command === "invalid") {
    console.error("Unknown arguments. Run `lh --help`.");
    return 2;
  }

  const path = dependencies.configFile ?? configPath();
  let config: LocalHubConfig;
  try {
    config = await (dependencies.load ?? loadConfig)(path);
  } catch (error) {
    console.error(`Configuration error: ${errorMessage(error)}`);
    console.error(`Fix ${path}, or remove it to restore defaults.`);
    return 2;
  }

  if (command === "status" || command === "doctor") {
    let runtime: Awaited<ReturnType<typeof collectRuntime>>;
    try {
      runtime = await (dependencies.collect ?? collectRuntime)(config, {
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      });
    } catch (error) {
      console.error(`State check failed: ${errorMessage(error)}`);
      console.error("Fix: verify this platform build, then retry `lh doctor`.");
      return 1;
    }
    if (command === "status") {
      console.log(renderStatus(runtime.snapshot, config, path));
      return runtime.snapshot.route && runtime.snapshot.codexPath ? 0 : 1;
    }
    const checks = diagnose(runtime.snapshot, config);
    console.log(renderDoctor(checks));
    return checks.some((check) => check.level === "fail") ? 1 : 0;
  }

  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const env = dependencies.env ?? process.env;
  const interactive =
    dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let sessionToken: string | undefined;
  if (command === "setup") {
    if (!interactive) {
      console.error("The setup wizard needs an interactive terminal.");
      return 2;
    }
    let setup: SetupResult;
    try {
      setup = await (dependencies.runSetupWizard ?? runSetup)(config, path, {
        arch,
        env,
        platform,
        saveConfig: (next) => (dependencies.save ?? saveConfig)(next, path),
      });
    } catch (error) {
      console.error(`Setup failed: ${errorMessage(error)}`);
      console.error("Fix the reported dependency or connection, then rerun `lh setup`.");
      return 1;
    }
    if (setup.kind === "cancelled") {
      return 0;
    }
    if (setup.kind === "incomplete") {
      return 1;
    }
    config = setup.config;
    sessionToken = setup.sessionToken;
    if (!setup.launch) {
      return setup.ready ? 0 : 1;
    }
  }

  if (
    (platform !== "darwin" && platform !== "win32") ||
    (platform === "darwin" && arch !== "arm64") ||
    (platform === "win32" && arch !== "x64")
  ) {
    console.error("LocalHub supports macOS arm64 and Windows x64.");
    return 2;
  }
  if (!interactive) {
    console.error("The LocalHub TUI needs an interactive terminal. Run `lh status` instead.");
    return 2;
  }

  if (command === "tui" && platform === "win32" && config.lanEndpoint && !env[config.tokenEnv]) {
    let needsToken = false;
    try {
      const preflight = await (dependencies.collect ?? collectRuntime)(config, {
        env,
        platform,
      });
      needsToken = preflight.snapshot.attempts.some(
        (attempt) => attempt.kind === "windows-lan" && attempt.auth === "missing",
      );
    } catch {
      // The TUI owns detailed connection diagnostics when preflight itself fails.
    }
    if (needsToken) {
      try {
        sessionToken =
          (await (dependencies.readSecret ?? readHiddenInput)(
            `Direct-LAN token for ${new URL(config.lanEndpoint).hostname}`,
          )) ?? undefined;
      } catch (error) {
        console.error(`Token input failed: ${errorMessage(error)}`);
        return 1;
      }
      if (!sessionToken) {
        console.error("Direct-LAN token entry cancelled. Run `lh` to retry.");
        return 1;
      }
    }
  }

  let result: Awaited<ReturnType<typeof runTui>>;
  try {
    const tuiEnv = sessionToken ? { ...env, [config.tokenEnv]: sessionToken } : env;
    result = await (dependencies.runInteractive ?? runTui)(config, path, { env: tuiEnv });
  } catch (error) {
    console.error(`LocalHub TUI failed: ${errorMessage(error)}`);
    console.error("Fix: install the matching platform build and run `lh doctor`.");
    return 1;
  }
  if (result.kind === "quit") {
    return 0;
  }
  const spec = buildCodexProcess({
    baseEnv: env,
    codexPath: result.codexPath,
    modelId: result.modelId,
    endpoint: result.endpoint,
    contextLength: config.contextLength,
    cwd: process.cwd(),
    ...(result.token ? { token: result.token } : {}),
    sourceTokenEnv: config.tokenEnv,
  });
  try {
    return await (dependencies.runLocalCodex ?? runCodex)(spec);
  } catch (error) {
    console.error(`Codex failed to start: ${errorMessage(error)}`);
    console.error("Fix: reinstall Codex and confirm `codex --version` works in this shell.");
    return 1;
  }
}

function parseCommand(
  args: string[],
): "tui" | "setup" | "status" | "doctor" | "help" | "version" | "invalid" {
  if (args.length === 0) {
    return "tui";
  }
  if (args.length !== 1) {
    return "invalid";
  }
  switch (args[0]) {
    case "status":
      return "status";
    case "doctor":
      return "doctor";
    case "setup":
      return "setup";
    case "help":
    case "--help":
    case "-h":
      return "help";
    case "--version":
    case "-V":
      return "version";
    default:
      return "invalid";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ConfigError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (import.meta.main) {
  process.exitCode = await main();
}
