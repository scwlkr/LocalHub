#!/usr/bin/env bun

import { dirname, join } from "node:path";
import { buildCodexProcess, runCodex } from "./codex.ts";
import { ConfigError, configPath, loadConfig, saveConfig } from "./config.ts";
import { diagnose } from "./diagnostics.ts";
import { validateEvidenceRecord } from "./evidence.ts";
import { runGuidedFirstRun } from "./guided-runway.ts";
import {
  createNativeGuidedDependencies,
  defaultFirstRunStatePath,
  defaultModelStoragePath,
} from "./guided-native.ts";
import { renderDoctor, renderStatus } from "./presentation.ts";
import { THIRD_PARTY_NOTICES } from "./notices.ts";
import { verifyReleaseCandidate, type ReleaseAssetInspection } from "./release.ts";
import {
  RunCommandError,
  defaultRunStateDirectory,
  currentPrivateInterfaces,
  inspectLocalHubRun,
  recheckMemberLink,
  runBundleFromCandidate,
  serveLocalHubRun,
  startLocalHubRun,
  stopLocalHubRun,
  type LocalHubRunState,
  type RunInspection,
} from "./run.ts";
import { createMemberBinding } from "./member-gateway.ts";
import { collectRuntime } from "./runtime.ts";
import { readHiddenInput, runSetup, type SetupResult } from "./setup.ts";
import { runTui } from "./tui.ts";
import type { LocalHubConfig } from "./types.ts";
export { VERSION } from "./version.ts";
import { BUILD_COMMIT, VERSION } from "./version.ts";

const HELP = `LocalHub ${VERSION}

Usage:
  lh                 Enter Guided First Run from an assembled candidate
  lh first-run       Resume Guided First Run explicitly
  lh setup           Configure Windows access with a guided wizard
  lh status          Show system, route, server, and model state
  lh doctor          Check setup and print concise fixes
  lh run start       Explicitly start the detached LocalHub Run
  lh run status      Show exact supervisor, runtime, listeners, and health
  lh stop            Reject new work and stop only LocalHub-owned processes
  lh member recheck  Explicitly verify and republish after network change/wake
  lh release identity <release-candidate.json>
                     Verify and print the exact assembled candidate identity
  lh release notices  Print bundled third-party license notices
  lh evidence validate <release-candidate.json> <evidence.json>
                     Reject malformed, stale, sensitive, or mismatched evidence
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
  buildCommit?: string;
  collect?: typeof collectRuntime;
  configFile?: string;
  interactive?: boolean;
  load?: typeof loadConfig;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  inspectReleaseAsset?: (path: string) => Promise<ReleaseAssetInspection>;
  platform?: NodeJS.Platform;
  runInteractive?: typeof runTui;
  runLocalCodex?: typeof runCodex;
  readSecret?: typeof readHiddenInput;
  runSetupWizard?: typeof runSetup;
  save?: typeof saveConfig;
  terminalColumns?: number;
  terminalRows?: number;
  runCandidateRecordPath?: string;
  runStateDirectory?: string;
  inspectRun?: (stateDirectory: string) => Promise<RunInspection>;
  startRun?: typeof startLocalHubRun;
  stopRun?: typeof stopLocalHubRun;
  firstRunStatePath?: string;
  runFirstRun?: (options: FirstRunCommandOptions) => Promise<"ready" | "cancelled">;
  recheckMember?: typeof recheckMemberLink;
}

export interface FirstRunCommandOptions {
  buildCommit: string;
  candidateRecordPath: string;
  executablePath: string;
  runStateDirectory: string;
  statePath: string;
}

export async function main(
  args = Bun.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  if (args[0] === "__run-agent") {
    return runSupervisorAgent(args, dependencies);
  }
  if (args[0] === "release") {
    if (args.length === 2 && args[1] === "notices") {
      console.log(THIRD_PARTY_NOTICES.trimEnd());
      return 0;
    }
    if (args.length === 2 && args[1] === "build-commit") {
      if (!/^[0-9a-f]{40}$/.test(BUILD_COMMIT)) {
        console.error("Build commit is unavailable from a source checkout.");
        return 2;
      }
      console.log(BUILD_COMMIT);
      return 0;
    }
    if (args.length !== 3 || args[1] !== "identity") {
      console.error("Usage: lh release identity <release-candidate.json>");
      return 2;
    }
    try {
      const candidate = await verifyReleaseCandidate(
        args[2] ?? "",
        dependencies.executablePath ?? process.execPath,
        {
          buildCommit: dependencies.buildCommit ?? BUILD_COMMIT,
          ...(dependencies.inspectReleaseAsset
            ? { inspectAsset: dependencies.inspectReleaseAsset }
            : {}),
        },
      );
      console.log(JSON.stringify(candidate, null, 2));
      return 0;
    } catch (error) {
      console.error(`Release identity verification failed: ${errorMessage(error)}`);
      return 1;
    }
  }
  if (args[0] === "evidence") {
    if (args.length !== 4 || args[1] !== "validate") {
      console.error("Usage: lh evidence validate <release-candidate.json> <evidence.json>");
      return 2;
    }
    try {
      const candidate = await verifyReleaseCandidate(
        args[2] ?? "",
        dependencies.executablePath ?? process.execPath,
        {
          buildCommit: dependencies.buildCommit ?? BUILD_COMMIT,
          ...(dependencies.inspectReleaseAsset
            ? { inspectAsset: dependencies.inspectReleaseAsset }
            : {}),
        },
      );
      const record = await Bun.file(args[3] ?? "").json();
      const evidence = validateEvidenceRecord(record, candidate);
      console.log(
        evidence.releaseEvidence
          ? `Evidence valid for assembled candidate ${candidate.candidate.candidateId}.`
          : `Controlled dependency evidence valid for ${candidate.candidate.candidateId}; it is not release evidence.`,
      );
      return 0;
    } catch (error) {
      console.error(`Evidence validation failed: ${errorMessage(error)}`);
      return 1;
    }
  }
  const executablePath = dependencies.executablePath ?? process.execPath;
  const candidateRecordPath =
    dependencies.runCandidateRecordPath ?? join(dirname(executablePath), "release-candidate.json");
  const assembledDefault = args.length === 0 && (await Bun.file(candidateRecordPath).exists());
  if (assembledDefault || (args.length === 1 && args[0] === "first-run")) {
    const interactive =
      dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      console.error("Guided First Run needs an interactive Host terminal.");
      return 2;
    }
    const runStateDirectory =
      dependencies.runStateDirectory ?? defaultRunStateDirectory(dependencies.env ?? process.env);
    const statePath =
      dependencies.firstRunStatePath ?? defaultFirstRunStatePath(dependencies.env ?? process.env);
    try {
      const result = await (dependencies.runFirstRun ?? runFirstRunCommand)({
        buildCommit: dependencies.buildCommit ?? BUILD_COMMIT,
        candidateRecordPath,
        executablePath,
        runStateDirectory,
        statePath,
      });
      return result === "ready" || result === "cancelled" ? 0 : 1;
    } catch (error) {
      console.error(`Guided First Run failed: ${errorMessage(error)}`);
      return 1;
    }
  }
  if (args.length === 2 && args[0] === "member" && args[1] === "recheck") {
    const stateDirectory =
      dependencies.runStateDirectory ?? defaultRunStateDirectory(dependencies.env ?? process.env);
    try {
      const member = await (dependencies.recheckMember ?? recheckMemberLink)(stateDirectory);
      console.log(JSON.stringify({ action: "member-recheck", member }, null, 2));
      return 0;
    } catch (error) {
      renderRunFailure(error);
      return 1;
    }
  }
  const runCommand = parseRunCommand(args);
  if (runCommand) {
    const stateDirectory =
      dependencies.runStateDirectory ?? defaultRunStateDirectory(dependencies.env ?? process.env);
    if (runCommand === "status") {
      const inspection = await (dependencies.inspectRun ?? inspectLocalHubRun)(stateDirectory);
      console.log(JSON.stringify(inspection, null, 2));
      return inspection.state === "failed" ? 1 : 0;
    }
    try {
      const state =
        runCommand === "start"
          ? await (dependencies.startRun ?? startLocalHubRun)({
              buildCommit: dependencies.buildCommit ?? BUILD_COMMIT,
              candidateRecordPath,
              executablePath,
              stateDirectory,
              ...(dependencies.inspectReleaseAsset
                ? { inspectReleaseAsset: dependencies.inspectReleaseAsset }
                : {}),
            })
          : await (dependencies.stopRun ?? stopLocalHubRun)({ stateDirectory });
      console.log(JSON.stringify(runResult(runCommand, state), null, 2));
      return 0;
    } catch (error) {
      renderRunFailure(error);
      return 1;
    }
  }
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
  const terminalColumns = dependencies.terminalColumns ?? process.stdout.columns;
  const terminalRows = dependencies.terminalRows ?? process.stdout.rows;
  if (
    (terminalColumns !== undefined && terminalColumns < 80) ||
    (terminalRows !== undefined && terminalRows < 18)
  ) {
    console.error(
      `Terminal too small (${terminalColumns ?? "unknown"}x${terminalRows ?? "unknown"}). LocalHub needs at least 80x18.`,
    );
    console.error("Fix: enlarge the terminal and rerun `lh`; use `lh status` meanwhile.");
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

async function runFirstRunCommand(options: FirstRunCommandOptions): Promise<"ready" | "cancelled"> {
  const candidate = await verifyReleaseCandidate(
    options.candidateRecordPath,
    options.executablePath,
    {
      buildCommit: options.buildCommit,
    },
  );
  const bundle = runBundleFromCandidate(options.candidateRecordPath, candidate);
  const result = await runGuidedFirstRun(
    {
      candidate,
      defaultModelStorage: defaultModelStoragePath(),
      statePath: options.statePath,
    },
    createNativeGuidedDependencies({
      bundle,
      run: {
        buildCommit: options.buildCommit,
        candidateRecordPath: options.candidateRecordPath,
        executablePath: options.executablePath,
        stateDirectory: options.runStateDirectory,
      },
    }),
  );
  return result.kind;
}

async function runSupervisorAgent(args: string[], dependencies: CliDependencies): Promise<number> {
  const parsed = parseSupervisorArgs(args);
  if (!parsed) {
    console.error("Invalid internal LocalHub supervisor arguments.");
    return 2;
  }
  const executablePath = dependencies.executablePath ?? process.execPath;
  try {
    const candidate = await verifyReleaseCandidate(parsed.candidateRecordPath, executablePath, {
      buildCommit: dependencies.buildCommit ?? BUILD_COMMIT,
      ...(dependencies.inspectReleaseAsset
        ? { inspectAsset: dependencies.inspectReleaseAsset }
        : {}),
    });
    const member = parsed.member
      ? await createMemberBinding({
          selected: parsed.member.interface,
          available: currentPrivateInterfaces(),
          bonjourName: parsed.member.bonjourName,
          port: parsed.member.port,
        })
      : undefined;
    await serveLocalHubRun({
      bundle: runBundleFromCandidate(parsed.candidateRecordPath, candidate),
      hostPort: parsed.hostPort,
      llamaPort: parsed.llamaPort,
      stateDirectory: parsed.stateDirectory,
      startupDeadlineMs: 30_000,
      stopDeadlineMs: 10_000,
      ...(parsed.modelsDirectory ? { modelsDirectory: parsed.modelsDirectory } : {}),
      ...(member ? { member } : {}),
    });
    return 0;
  } catch (error) {
    console.error(`LocalHub supervisor failed: ${errorMessage(error)}`);
    return 1;
  }
}

function parseRunCommand(args: string[]): "start" | "status" | "stop" | null {
  if (args.length === 1 && args[0] === "stop") return "stop";
  if (args.length === 2 && args[0] === "run") {
    if (args[1] === "start" || args[1] === "status" || args[1] === "stop") {
      return args[1];
    }
  }
  return null;
}

function parseSupervisorArgs(args: string[]): {
  candidateRecordPath: string;
  stateDirectory: string;
  hostPort: number;
  llamaPort: number;
  modelsDirectory?: string;
  member?: {
    interface: { name: string; address: string; netmask: string };
    bonjourName: string;
    port: number;
  };
} | null {
  if (
    args.length < 9 ||
    args[1] !== "--candidate" ||
    args[3] !== "--state-dir" ||
    args[5] !== "--host-port" ||
    args[7] !== "--llama-port"
  ) {
    return null;
  }
  const optional = new Map<string, string>();
  for (let index = 9; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || optional.has(name)) return null;
    optional.set(name, value);
  }
  const allowed = new Set([
    "--models-dir",
    "--member-interface",
    "--member-address",
    "--member-netmask",
    "--bonjour-name",
    "--member-port",
  ]);
  if ([...optional.keys()].some((name) => !allowed.has(name))) return null;
  const hostPort = Number(args[6]);
  const llamaPort = Number(args[8]);
  if (
    !Number.isInteger(hostPort) ||
    !Number.isInteger(llamaPort) ||
    hostPort < 1024 ||
    hostPort > 65535 ||
    llamaPort < 1024 ||
    llamaPort > 65535 ||
    hostPort === llamaPort
  ) {
    return null;
  }
  const memberValues = [
    optional.get("--member-interface"),
    optional.get("--member-address"),
    optional.get("--member-netmask"),
    optional.get("--bonjour-name"),
    optional.get("--member-port"),
  ];
  if (memberValues.some(Boolean) && memberValues.some((value) => value === undefined)) return null;
  const memberPort = memberValues[4] === undefined ? null : Number(memberValues[4]);
  if (
    memberPort !== null &&
    (!Number.isInteger(memberPort) || memberPort < 1024 || memberPort > 65535)
  ) {
    return null;
  }
  return {
    candidateRecordPath: args[2] ?? "",
    stateDirectory: args[4] ?? "",
    hostPort,
    llamaPort,
    ...(optional.get("--models-dir")
      ? { modelsDirectory: optional.get("--models-dir") as string }
      : {}),
    ...(memberPort === null
      ? {}
      : {
          member: {
            interface: {
              name: memberValues[0] as string,
              address: memberValues[1] as string,
              netmask: memberValues[2] as string,
            },
            bonjourName: memberValues[3] as string,
            port: memberPort,
          },
        }),
  };
}

function runResult(
  action: "start" | "stop",
  state: LocalHubRunState | null,
): Record<string, unknown> {
  return {
    action,
    status: state?.status ?? "stopped",
    acceptingWork: state?.acceptingWork ?? false,
    activeWork: state?.activeWork ?? 0,
    stop: state?.stop ?? null,
    run: state,
  };
}

function renderRunFailure(error: unknown): void {
  const failure =
    error instanceof RunCommandError
      ? error.failure
      : {
          cause: errorMessage(error),
          protectedState:
            "No unverified process was signalled; models, LM Studio, configuration, and source files remain untouched.",
          stillWorks: "The stopped LocalHub CLI remains available.",
          repair: "Inspect the exact candidate and recorded loopback listeners.",
          recheck: "Run `lh run status` again.",
        };
  console.error(`Cause: ${failure.cause}`);
  console.error(`Protected state: ${failure.protectedState}`);
  console.error(`Still works: ${failure.stillWorks}`);
  console.error(`Repair: ${failure.repair}`);
  console.error(`Recheck: ${failure.recheck}`);
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
