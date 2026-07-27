import { spawn, type ChildProcess } from "node:child_process";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConsoleSetupIO } from "./setup.ts";
import { fileIdentity } from "./release.ts";
import {
  buildLlamaLaunch,
  currentPrivateInterfaces,
  inspectLocalHubRun,
  publishBonjourService,
  startLocalHubRun,
  type RunBundle,
  type RunCommandOptions,
} from "./run.ts";
import {
  createMemberGatewayHandler,
  reconcileMemberBinding,
  type MemberBinding,
} from "./member-gateway.ts";
import type { GuidedFirstRunDependencies, GuidedRuntimeResult } from "./guided-runway.ts";
import type { HostComputerObservation } from "./first-run.ts";

export interface NativeGuidedDependenciesOptions {
  bundle: RunBundle;
  run: RunCommandOptions;
  memberReadinessDeadlineMs?: number;
}

export function defaultFirstRunStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOCALHUB_FIRST_RUN_STATE) return resolve(env.LOCALHUB_FIRST_RUN_STATE);
  return join(homedir(), "Library", "Application Support", "LocalHub", "first-run-v1.json");
}

export function defaultModelStoragePath(): string {
  return join(homedir(), "Library", "Application Support", "LocalHub", "models");
}

export function createNativeGuidedDependencies(
  options: NativeGuidedDependenciesOptions,
): GuidedFirstRunDependencies {
  const memberDeadlineMs = options.memberReadinessDeadlineMs ?? 300_000;
  return {
    io: createConsoleSetupIO(),
    observeHost: observeHostComputer,
    prepareModelStorage,
    verifyRuntime: (modelStorage) => verifyPinnedRuntime(options.bundle, modelStorage),
    currentInterfaces: currentPrivateInterfaces,
    resolveBonjourName,
    verifyPhysicalMember: (binding) => verifyPhysicalMember(binding, memberDeadlineMs),
    startRun: async (modelStorageDirectory, member) => {
      const run = await startLocalHubRun({
        ...options.run,
        startupDeadlineMs: memberDeadlineMs,
        modelStorageDirectory,
        member: {
          interface: member.interface,
          bonjourName: member.bonjourName,
          port: member.port,
        },
      });
      return { runId: run.runId, hostOrigin: run.host.origin };
    },
    inspectRun: async (runId) => {
      const inspection = await inspectLocalHubRun(options.run.stateDirectory);
      if (
        inspection.state !== "running" ||
        !inspection.identityProven ||
        !inspection.run ||
        inspection.run.runId !== runId
      ) {
        throw new Error("The exact LocalHub Run is not active for Ready recheck.");
      }
      return {
        runId: inspection.run.runId,
        hostOrigin: inspection.run.host.origin,
        memberReady: inspection.run.member?.health === "ready",
      };
    },
    openDashboard: async (origin) => {
      await runFinite(["/usr/bin/open", origin], 5_000);
    },
  };
}

export async function observeHostComputer(): Promise<HostComputerObservation> {
  const [osVersion, firewallGlobal, firewallBlockAll, sleep, storage] = await Promise.all([
    runFinite(["/usr/bin/sw_vers", "-productVersion"], 2_000),
    runFinite(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"], 2_000).catch(
      (error) => `unavailable: ${errorMessage(error)}`,
    ),
    runFinite(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getblockall"], 2_000).catch(
      (error) => `unavailable: ${errorMessage(error)}`,
    ),
    runFinite(["/usr/bin/pmset", "-g", "custom"], 2_000).catch(
      (error) => `unavailable: ${errorMessage(error)}`,
    ),
    statfs(homedir()),
  ]);
  return {
    platform: process.platform,
    architecture: process.arch,
    osVersion: osVersion.trim(),
    freeBytes: storage.bavail * storage.bsize,
    interfaces: currentPrivateInterfaces(),
    firewall: {
      enabled: /enabled|state\s*=\s*1/i.test(firewallGlobal),
      blockAll: /enabled|state\s*=\s*1/i.test(firewallBlockAll),
      localHubAllowed: null,
    },
    sleep: { wakeForNetworkAccess: /\bwomp\s+1\b/.test(sleep) },
  };
}

export async function prepareModelStorage(
  requestedPath: string,
): Promise<{ path: string; freeBytes: number }> {
  const path = resolve(requestedPath);
  let root: Stats;
  try {
    root = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    root = await lstat(path);
  }
  if (root.isSymbolicLink()) {
    throw new Error("The confirmed Model Storage path must not be a symbolic link.");
  }
  if (!root.isDirectory()) {
    throw new Error("The confirmed Model Storage path is not a folder.");
  }
  for (const name of [".localhub-catalog", ".localhub-staging"]) {
    const managed = join(path, name);
    let entry: Stats;
    try {
      entry = await lstat(managed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(managed, { mode: 0o700 });
      entry = await lstat(managed);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Managed Model Storage path ${name} must not be a symbolic link.`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`Managed Model Storage path ${name} is not a folder.`);
    }
  }
  const storage = await statfs(path);
  return { path, freeBytes: storage.bavail * storage.bsize };
}

export async function verifyPinnedRuntime(
  bundle: RunBundle,
  _modelStorage: string,
  deadlineMs = 30_000,
): Promise<GuidedRuntimeResult> {
  const deadline = Date.now() + deadlineMs;
  const actualBinary = await fileIdentity(bundle.llama.binaryPath);
  if (
    actualBinary.size !== bundle.llama.binary.size ||
    actualBinary.sha256 !== bundle.llama.binary.sha256
  ) {
    throw new Error("Pinned llama.cpp binary identity changed after candidate verification.");
  }
  const version = await runFinite([bundle.llama.binaryPath, "--version"], remaining(deadline));
  if (!/version:\s*10107\b/.test(version) || !version.includes("c0bc8591e")) {
    throw new Error("Pinned llama.cpp did not report build b10107 at c0bc8591e.");
  }
  const devices = (
    await runFinite([bundle.llama.binaryPath, "--list-devices"], remaining(deadline))
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (devices.length === 0) throw new Error("Pinned llama.cpp returned no Metal device result.");

  const port = await availableLoopbackPort();
  const routerModelsDirectory = await mkdtemp(join(tmpdir(), "localhub-sealed-router-"));
  await chmod(routerModelsDirectory, 0o700);
  const launch = buildLlamaLaunch(bundle, { modelsDirectory: routerModelsDirectory, port });
  const child = spawn(launch.command[0] ?? "", launch.command.slice(1), {
    cwd: routerModelsDirectory,
    env: runtimeEnvironment(),
    stdio: "ignore",
  });
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  try {
    let healthy = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Pinned llama.cpp exited before the finite health check passed.");
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(250),
        });
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // A finite retry remains inside the single declared deadline.
      }
      await Bun.sleep(20);
    }
    if (!healthy)
      throw new Error("Pinned llama.cpp health did not pass before the finite deadline.");
    const modelsResponse = await fetch(`http://127.0.0.1:${port}/models`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, remaining(deadline)))),
    });
    const routerModels: unknown = modelsResponse.ok ? await modelsResponse.json() : null;
    if (!emptyRouterInventory(routerModels)) {
      throw new Error(
        "Pinned llama.cpp sealed router exposed a model before exact Installed Model selection.",
      );
    }
    child.kill("SIGTERM");
    if (!(await waitForExit(child, Math.min(5_000, remaining(deadline))))) {
      child.kill("SIGKILL");
      if (!(await waitForExit(child, 1_000))) {
        throw new Error("Pinned llama.cpp cleanup could not prove process exit after SIGKILL.");
      }
      throw new Error("Pinned llama.cpp did not stop cleanly before the finite deadline.");
    }
  } catch (error) {
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      if (!(await waitForExit(child, 1_000))) {
        throw new Error("Pinned llama.cpp cleanup could not prove process exit after failure.");
      }
    }
    throw error;
  } finally {
    await rm(routerModelsDirectory, { recursive: true, force: true });
  }
  return {
    build: "b10107",
    architecture: "arm64",
    binary: bundle.llama.binary,
    devices,
    emptyRouterProcessLaunch: "passed",
    health: "passed",
    stop: "passed",
    noModelLoaded: true,
    deadlineMs,
  };
}

function emptyRouterInventory(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { object?: unknown }).object === "list" &&
    Array.isArray((value as { data?: unknown }).data) &&
    (value as { data: unknown[] }).data.length === 0
  );
}

export async function resolveBonjourName(): Promise<string> {
  const name = (await runFinite(["/usr/sbin/scutil", "--get", "LocalHostName"], 2_000)).trim();
  if (!name) throw new Error("macOS did not report an actual Bonjour local hostname.");
  return `${name.replace(/\.local$/i, "")}.local`;
}

export async function verifyPhysicalMember(
  binding: MemberBinding,
  deadlineMs: number,
): Promise<{ physicalFriendlyPassed: boolean; physicalIpv4Passed: boolean }> {
  const visited = { friendly: false, ipv4: false };
  let server: ReturnType<typeof Bun.serve> | null = null;
  const handler = createMemberGatewayHandler(
    binding,
    (request) => {
      return server?.requestIP(request)?.address ?? null;
    },
    (route, peer) => {
      const normalized = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
      if (normalized !== binding.interface.address) visited[route] = true;
    },
    () => "verification-required",
  );
  server = Bun.serve({
    hostname: binding.interface.address,
    port: binding.port,
    fetch: handler,
  });
  const publication = await publishBonjourService(binding).catch(async (error) => {
    await server?.stop(true);
    throw error;
  });
  let publicationFailure: Error | null = null;
  void publication.exited.then((failure) => {
    publicationFailure = failure;
  });
  try {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (publicationFailure) throw publicationFailure;
      const network = reconcileMemberBinding(binding, currentPrivateInterfaces());
      if (network.status === "withdrawn") throw new Error(network.failure.cause);
      if (visited.friendly && visited.ipv4)
        return {
          physicalFriendlyPassed: true,
          physicalIpv4Passed: true,
        };
      await Bun.sleep(250);
    }
    return {
      physicalFriendlyPassed: visited.friendly,
      physicalIpv4Passed: visited.ipv4,
    };
  } finally {
    await server.stop(true);
    await publication.stop();
  }
}

async function availableLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined)
    throw new Error("No loopback port was available for runtime verification.");
  return port;
}

async function runFinite(command: string[], deadlineMs: number): Promise<string> {
  if (deadlineMs <= 0) throw new Error("The finite command deadline expired.");
  const child = spawn(command[0] ?? "", command.slice(1), {
    env: runtimeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  if (!(await waitForExit(child, deadlineMs))) {
    child.kill("SIGKILL");
    if (!(await waitForExit(child, 1_000))) {
      throw new Error(`${command[0] ?? "command"} cleanup could not prove process exit.`);
    }
    throw new Error(`${command[0] ?? "command"} exceeded its finite deadline.`);
  }
  if (spawnError) throw spawnError;
  const output = `${Buffer.concat(stdout).toString()}\n${Buffer.concat(stderr).toString()}`.trim();
  if (child.exitCode !== 0) {
    throw new Error(`${command[0] ?? "command"} exited ${String(child.exitCode)}: ${output}`);
  }
  return output;
}

async function waitForExit(child: ChildProcess, deadlineMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(1, deadlineMs));
    const finish = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEM_VERSION_COMPAT"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
