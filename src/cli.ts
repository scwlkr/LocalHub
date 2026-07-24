#!/usr/bin/env bun

import { buildCodexProcess, runCodex } from "./codex.ts";
import { ConfigError, configPath, loadConfig } from "./config.ts";
import { diagnose } from "./diagnostics.ts";
import { renderDoctor, renderStatus } from "./presentation.ts";
import { collectRuntime } from "./runtime.ts";
import { runTui } from "./tui.ts";
import type { LocalHubConfig } from "./types.ts";

export const VERSION = "0.1.0";

const HELP = `LocalHub ${VERSION}

Usage:
  lh                 Open the model picker
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

API tokens are never stored. Set the environment variable named by tokenEnv
(default: LM_API_TOKEN) only in the shell that runs lh.
`;

export async function main(args = Bun.argv.slice(2)): Promise<number> {
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

  const path = configPath();
  let config: LocalHubConfig;
  try {
    config = await loadConfig(path);
  } catch (error) {
    console.error(`Configuration error: ${errorMessage(error)}`);
    console.error(`Fix ${path}, or remove it to restore defaults.`);
    return 2;
  }

  if (command === "status" || command === "doctor") {
    const runtime = await collectRuntime(config);
    if (command === "status") {
      console.log(renderStatus(runtime.snapshot, config, path));
      return runtime.snapshot.route && runtime.snapshot.codexPath ? 0 : 1;
    }
    const checks = diagnose(runtime.snapshot, config);
    console.log(renderDoctor(checks));
    return checks.some((check) => check.level === "fail") ? 1 : 0;
  }

  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.error("LocalHub supports macOS arm64 and Windows x64.");
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("The LocalHub TUI needs an interactive terminal. Run `lh status` instead.");
    return 2;
  }

  const result = await runTui(config, path);
  if (result.kind === "quit") {
    return 0;
  }
  const spec = buildCodexProcess({
    codexPath: result.codexPath,
    modelId: result.modelId,
    endpoint: result.endpoint,
    contextLength: config.contextLength,
    cwd: process.cwd(),
    ...(result.token ? { token: result.token } : {}),
    sourceTokenEnv: config.tokenEnv,
  });
  return runCodex(spec);
}

function parseCommand(
  args: string[],
): "tui" | "status" | "doctor" | "help" | "version" | "invalid" {
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
