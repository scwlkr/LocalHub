import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import {
  createMemberBinding,
  isPeerOnSelectedSubnet,
  type MemberBinding,
  type PrivateInterface,
} from "../src/member-gateway.ts";
import {
  buildLlamaLaunch,
  buildSupervisorLaunch,
  currentPrivateInterfaces,
  inspectLocalHubRun,
  type LocalHubRunState,
  publishBonjourService,
  RUN_STATE_SCHEMA,
  type RunBundle,
  readRunState,
  serveLocalHubRun,
  startLocalHubRun,
  stopLocalHubRun,
  writeRunState,
} from "../src/run.ts";

const testRoots: string[] = [];
const macOSProcessTest = process.platform === "darwin" ? test : test.skip;

afterEach(async () => {
  for (const path of testRoots.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

test("the pinned router launch is loopback-only and disables automatic or built-in authority", () => {
  const launch = buildLlamaLaunch(bundle("/candidate/runtime/llama.cpp/llama-server"), {
    modelsDirectory: "/state/empty-models",
    port: 39282,
  });

  expect(launch.command).toEqual([
    "/candidate/runtime/llama.cpp/llama-server",
    "--host",
    "127.0.0.1",
    "--port",
    "39282",
    "--models-dir",
    "/state/empty-models",
    "--no-models-autoload",
    "--models-max",
    "1",
    "--fit",
    "off",
    "--no-webui",
    "--no-agent",
    "--no-ui-mcp-proxy",
    "--cors-origins",
    "localhost",
  ]);
  expect(launch.command).not.toContain("--tools");
  expect(launch.observedControls).toMatchObject({
    host: "127.0.0.1",
    modelAutoload: false,
    automaticFit: false,
    webUi: false,
    builtInAgent: false,
    builtInTools: false,
    mcpProxy: false,
    model: null,
    runProfile: null,
  });
});

test("the supervisor launch survives terminal loss without inheriting terminal streams", () => {
  const launch = buildSupervisorLaunch({
    candidateRecordPath: "/candidate/release-candidate.json",
    executablePath: "/candidate/lh",
    hostPort: 39281,
    llamaPort: 39282,
    logPath: "/state/run.log",
    stateDirectory: "/state",
  });

  expect(launch.detached).toBe(true);
  expect(launch.stdio).toEqual(["ignore", "/state/run.log", "/state/run.log"]);
  expect(launch.command).toEqual([
    "/candidate/lh",
    "__run-agent",
    "--candidate",
    "/candidate/release-candidate.json",
    "--state-dir",
    "/state",
    "--host-port",
    "39281",
    "--llama-port",
    "39282",
  ]);
});

test("the supervisor receives one explicit selected-interface Member boundary", () => {
  const launch = buildSupervisorLaunch({
    candidateRecordPath: "/candidate/release-candidate.json",
    executablePath: "/candidate/lh",
    hostPort: 39281,
    llamaPort: 39282,
    logPath: "/state/run.log",
    stateDirectory: "/state",
    modelStorageDirectory: "/models",
    member: {
      interface: { name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" },
      bonjourName: "localhub-test.local",
      port: 39283,
    },
  });

  expect(launch.command).toEqual([
    "/candidate/lh",
    "__run-agent",
    "--candidate",
    "/candidate/release-candidate.json",
    "--state-dir",
    "/state",
    "--host-port",
    "39281",
    "--llama-port",
    "39282",
    "--model-storage",
    "/models",
    "--member-interface",
    "en0",
    "--member-address",
    "192.168.50.20",
    "--member-netmask",
    "255.255.255.0",
    "--bonjour-name",
    "localhub-test.local",
    "--member-port",
    "39283",
  ]);
  expect(launch.command).not.toContain("0.0.0.0");
});

test("the shipped CLI exposes explicit start/status/stop without replacing legacy status", async () => {
  const state = runningState();
  const calls: string[] = [];
  const start = await captureOutput(() =>
    main(["run", "start"], {
      buildCommit: "a".repeat(40),
      executablePath: "/candidate/lh",
      modelStoragePath: "/models",
      runCandidateRecordPath: "/candidate/release-candidate.json",
      runStateDirectory: "/state",
      startRun: async (options) => {
        calls.push(
          `start:${options.candidateRecordPath}:${options.stateDirectory}:${options.modelStorageDirectory}`,
        );
        return state;
      },
    }),
  );
  const status = await captureOutput(() =>
    main(["run", "status"], {
      runStateDirectory: "/state",
      inspectRun: async () => ({
        state: "running",
        run: state,
        failure: null,
        identityProven: true,
      }),
    }),
  );
  const stop = await captureOutput(() =>
    main(["stop"], {
      runStateDirectory: "/state",
      stopRun: async () => {
        calls.push("stop");
        return { ...state, status: "stopped", acceptingWork: false };
      },
    }),
  );

  expect(start.code).toBe(0);
  expect(status.code).toBe(0);
  expect(stop.code).toBe(0);
  expect(calls).toEqual(["start:/candidate/release-candidate.json:/state:/models", "stop"]);
  expect(start.output.join("\n")).toContain('"model": null');
  expect(status.output.join("\n")).toContain('"listener": "127.0.0.1:39282"');
});

test("the shipped CLI exposes one explicit Member recheck", async () => {
  const result = await captureOutput(() =>
    main(["member", "recheck"], {
      runStateDirectory: "/state",
      recheckMember: async (stateDirectory) => {
        expect(stateDirectory).toBe("/state");
        return {
          interface: { name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" },
          bonjourName: "localhub-test.local",
          port: 39283,
          friendlyUrl: "http://localhub-test.local:39283",
          ipv4Url: "http://192.168.50.20:39283",
          listener: "192.168.50.20:39283",
          health: "ready",
          bonjourPublished: true,
          failure: null,
        };
      },
    }),
  );

  expect(result.code).toBe(0);
  expect(result.output.join("\n")).toContain('"action": "member-recheck"');
});

test("status rejects a wrong process identity and preserves it", async () => {
  const state = runningState();
  const result = await inspectLocalHubRun("/state", {
    fetch: async () =>
      new Response(JSON.stringify({ ...state, runId: "different-run" }), {
        headers: { "content-type": "application/json" },
      }),
    readState: async () => state,
  });

  expect(result.state).toBe("failed");
  expect(result.identityProven).toBe(false);
  expect(result.failure?.cause).toContain("identity");
  expect(result.failure?.protectedState).toContain("No process was signalled");
  expect(result.failure?.repair).toContain("39281");
  expect(result.failure?.recheck).toBe("Run `lh run status` again.");
});

test("status rejects malformed or non-loopback state before network access", async () => {
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  const state = runningState();
  await writeFile(
    join(stateDirectory, "run-state.json"),
    JSON.stringify({ ...state, host: { ...state.host, origin: "http://example.com:39281" } }),
  );
  let requests = 0;
  const result = await inspectLocalHubRun(stateDirectory, {
    fetch: async () => {
      requests += 1;
      return Response.json(state);
    },
  });

  expect(result.state).toBe("failed");
  expect(result.identityProven).toBe(false);
  expect(result.failure?.cause).toContain("unreadable");
  expect(requests).toBe(0);
});

test("persisted Member state rejects public or VPN interfaces, unsafe ports, and mismatched URLs", async () => {
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  const base = runningState();
  const member = {
    interface: { name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" },
    bonjourName: "localhub-test.local",
    port: 39283,
    friendlyUrl: "http://localhub-test.local:39283",
    ipv4Url: "http://192.168.50.20:39283",
    listener: "192.168.50.20:39283",
    health: "ready" as const,
    bonjourPublished: true,
    failure: null,
  };
  const malformed = [
    { ...member, interface: { ...member.interface, name: "utun4", address: "10.9.0.2" } },
    { ...member, interface: { ...member.interface, address: "203.0.113.8" } },
    { ...member, interface: { ...member.interface, netmask: "255.0.255.0" } },
    { ...member, port: 80 },
    { ...member, friendlyUrl: "https://localhub-test.local:39283" },
    { ...member, listener: "192.168.50.20:40000" },
  ];

  for (const value of malformed) {
    await writeFile(
      join(stateDirectory, "run-state.json"),
      JSON.stringify({ ...base, member: value }),
    );
    await expect(readRunState(stateDirectory)).rejects.toThrow("unsafe");
  }
});

test("stop preserves a failed Host when its recorded identity is not proven", async () => {
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  let stopRequests = 0;
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/stop") stopRequests += 1;
      return Response.json({ ...runningState(), runId: "wrong-run" });
    },
  });
  try {
    const base = runningState();
    const state: LocalHubRunState = {
      ...base,
      status: "failed",
      acceptingWork: false,
      supervisor: { ...base.supervisor, pid: process.pid },
      host: { origin: `http://127.0.0.1:${host.port}`, health: "ready" },
      failure: {
        cause: "worker crashed",
        protectedState: "No substitute started.",
        stillWorks: "Host diagnosis remains available.",
        repair: "Run `lh stop`.",
        recheck: "Run `lh run status` again.",
      },
    };
    await writeRunState(stateDirectory, state);
    await expect(stopLocalHubRun({ stateDirectory, stopDeadlineMs: 100 })).rejects.toThrow(
      "does not match",
    );
    expect(stopRequests).toBe(0);
  } finally {
    await host.stop(true);
  }
});

test("stop marks an already-dead failed Run's recorded Member Link closed", async () => {
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  const base = runningState();
  await writeRunState(stateDirectory, {
    ...base,
    status: "failed",
    acceptingWork: false,
    member: {
      interface: { name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" },
      bonjourName: "localhub-test.local",
      port: 39283,
      friendlyUrl: "http://localhub-test.local:39283",
      ipv4Url: "http://192.168.50.20:39283",
      listener: "192.168.50.20:39283",
      health: "ready",
      bonjourPublished: true,
      failure: null,
    },
    failure: {
      cause: "The exact recorded Run is already offline.",
      protectedState: "No substitute started.",
      stillWorks: "Recorded state remains available.",
      repair: "Stop the recorded Run.",
      recheck: "Run `lh run status` again.",
    },
  });

  const stopped = await stopLocalHubRun({
    stateDirectory,
    processAlive: () => false,
  });

  expect(stopped?.status).toBe("stopped");
  expect(stopped?.member).toMatchObject({ health: "closed", bonjourPublished: false });
});

test("a timed-out stop never signals a process without a fresh ownership proof", async () => {
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  let stopRequests = 0;
  let state = runningState();
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "POST" && new URL(request.url).pathname === "/stop") {
        stopRequests += 1;
        return Response.json({ acceptingWork: false, activeWork: 3 });
      }
      return Response.json(state);
    },
  });
  const origin = `http://127.0.0.1:${host.port}`;
  state = {
    ...state,
    supervisor: { ...state.supervisor, pid: 424_242 },
    host: { origin, health: "ready" },
    llama: { ...state.llama, origin, listener: new URL(origin).host },
  };
  await writeRunState(stateDirectory, state);
  const signals: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    signals.push({ pid, signal });
    return true;
  }) as typeof process.kill;
  try {
    await expect(
      stopLocalHubRun({ stateDirectory, stopDeadlineMs: 1, processAlive: () => true }),
    ).rejects.toThrow("exceeded its finite process/listener deadline");
  } finally {
    process.kill = originalKill;
    await host.stop(true);
  }

  expect(stopRequests).toBe(1);
  expect(signals).toEqual([]);
  expect(await readFile(join(stateDirectory, "run-state.json"), "utf8")).toContain(
    '"status": "running"',
  );
});

macOSProcessTest("Bonjour cleanup fails closed when dns-sd exit cannot be proven", async () => {
  const binding = await createMemberBinding({
    selected: { name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" },
    available: [{ name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" }],
    bonjourName: "localhub-test.local",
    port: 39283,
  });
  const signals: string[] = [];
  const events = new EventEmitter();
  const child = Object.assign(events, {
    exitCode: null,
    signalCode: null,
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcess;
  queueMicrotask(() => events.emit("spawn"));
  let spawnedCommand: string | undefined;
  let spawnedArguments: readonly string[] | undefined;
  const publication = await publishBonjourService(binding, {
    spawn: ((command: string, arguments_: readonly string[]) => {
      spawnedCommand = command;
      spawnedArguments = arguments_;
      return child;
    }) as typeof import("node:child_process").spawn,
    sleep: async () => undefined,
    waitForExit: async () => false,
  });

  await expect(publication.stop()).rejects.toThrow("could not prove dns-sd exit");
  expect(spawnedCommand).toBe("/usr/bin/dns-sd");
  expect(spawnedArguments).toEqual([
    "-i",
    "en0",
    "-R",
    "LocalHub",
    "_http._tcp",
    "local.",
    "39283",
  ]);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

macOSProcessTest("listener ownership inspection ignores a hostile PATH lsof", async () => {
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  const runtimeDirectory = join(root, "runtime");
  const hostileBin = join(root, "hostile-bin");
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(hostileBin, { recursive: true }),
  ]);
  const fakeLlama = join(runtimeDirectory, "llama-server");
  const hostileLsof = join(hostileBin, "lsof");
  await Promise.all([
    writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 }),
    writeFile(
      hostileLsof,
      '#!/bin/sh\nprintf "invoked\\n" >> "$0.invoked"\nexec /usr/sbin/lsof "$@"\n',
      { mode: 0o755 },
    ),
  ]);
  const [hostPort, llamaPort] = await Promise.all([availablePort(), availablePort()]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${hostileBin}:${originalPath ?? ""}`;
  let hostileInspectorRan = false;
  let running: LocalHubRunState | null = null;
  const supervisor = serveLocalHubRun({
    bundle: bundle(fakeLlama),
    hostPort,
    llamaPort,
    stateDirectory,
    startupDeadlineMs: 2_000,
    stopDeadlineMs: 500,
  });
  try {
    running = await waitForState(stateDirectory, "running");
    hostileInspectorRan = await Bun.file(`${hostileLsof}.invoked`).exists();
  } finally {
    if (running) {
      await fetch(`${running.host.origin}/stop`, {
        method: "POST",
        headers: { "x-localhub-run-id": running.runId },
      });
    }
    await supervisor;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  expect(hostileInspectorRan).toBe(false);
});

macOSProcessTest(
  "the real macOS boundary tolerates a serialized version probe beyond fifteen seconds",
  async () => {
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    const modelStorageDirectory = join(root, "model-storage");
    await Promise.all([
      mkdir(runtimeDirectory, { recursive: true }),
      mkdir(join(modelStorageDirectory, ".localhub-staging", "acquisition"), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(join(modelStorageDirectory, "adoptable-unverified.gguf"), "unverified"),
      writeFile(
        join(modelStorageDirectory, ".localhub-staging", "acquisition", "partial.gguf"),
        "partial",
      ),
    ]);
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(
      fakeLlama,
      fakeLlamaSource({
        preflightLockPath: join(root, "preflight.lock"),
        versionDelayMs: 15_100,
      }),
      {
        mode: 0o755,
      },
    );
    const [hostPort, llamaPort] = await Promise.all([availablePort(), availablePort()]);

    const supervisor = serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      modelStorageDirectory,
      inspectModels: async (path) => {
        expect(path).toBe(modelStorageDirectory);
        return [
          {
            id: "a".repeat(64),
            displayName: "Exact Model",
            available: true,
            architecture: "qwen2",
            parameterCount: 1,
            quantization: { fileType: 1, tensorTypes: { F32: 1 } },
            trainingContext: 2048,
            templateHints: [],
            files: [],
            acquiredAt: "2026-07-27T00:00:00.000Z",
          },
        ];
      },
      stateDirectory,
      startupDeadlineMs: 20_000,
      stopDeadlineMs: 2_000,
    });
    const running = await waitForState(stateDirectory, "running", 18_000);
    const health = await fetch(`http://127.0.0.1:${hostPort}/health`).then((response) =>
      response.json(),
    );

    expect(health).toMatchObject({
      schema: RUN_STATE_SCHEMA,
      status: "running",
      acceptingWork: true,
      llama: {
        build: "b10107",
        architecture: "arm64",
        health: "ready",
        model: null,
        runProfile: null,
        builtInTools: false,
        builtInAgent: false,
      },
    });
    expect(running.llama.devices).toEqual(["Metal: Apple test GPU"]);
    expect(
      await fetch(`http://127.0.0.1:${llamaPort}/models`).then((response) => response.json()),
    ).toEqual({ object: "list", data: [] });
    expect(
      await fetch(`http://127.0.0.1:${hostPort}/models`).then((response) => response.json()),
    ).toMatchObject({
      installedModels: [{ id: "a".repeat(64), displayName: "Exact Model", architecture: "qwen2" }],
    });

    const stop = await fetch(`http://127.0.0.1:${hostPort}/stop`, {
      method: "POST",
      headers: { "x-localhub-run-id": running.runId },
    });
    expect(await stop.json()).toMatchObject({ acceptingWork: false, activeWork: 0 });
    await supervisor;
    const stopped = await waitForState(stateDirectory, "stopped");
    expect(stopped.stop).toMatchObject({ activeWork: 0, forcedProcesses: [] });
    await expect(fetch(`http://127.0.0.1:${hostPort}/health`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${llamaPort}/health`)).rejects.toThrow();
  },
  25_000,
);

macOSProcessTest(
  "hung macOS llama health fails once with one repair and no hidden restart",
  async () => {
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(fakeLlama, fakeLlamaSource({ healthStatus: 503 }), { mode: 0o755 });
    const [hostPort, llamaPort] = await Promise.all([availablePort(), availablePort()]);

    await expect(
      serveLocalHubRun({
        bundle: bundle(fakeLlama),
        hostPort,
        llamaPort,
        stateDirectory,
        startupDeadlineMs: 500,
        stopDeadlineMs: 500,
      }),
    ).rejects.toThrow("did not become healthy");
    const failed = await waitForState(stateDirectory, "failed");
    expect(failed.failure).toMatchObject({
      protectedState: expect.stringContaining("No model"),
      repair: expect.stringContaining("reported runtime"),
      recheck: "Run `lh run start`, then `lh run status`.",
    });
    expect(failed.restartAttempts).toBe(0);
  },
);

macOSProcessTest("mDNS publication failure closes the selected-interface gateway", async () => {
  const selected = currentPrivateInterfaces()[0];
  if (!selected) throw new Error("The supported macOS test lane has no private interface.");
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const fakeLlama = join(runtimeDirectory, "llama-server");
  await writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 });
  const [hostPort, llamaPort, memberPort] = await Promise.all([
    availablePort(),
    availablePort(),
    availablePortOn(selected.address),
  ]);
  const member = await createMemberBinding({
    selected,
    available: [selected],
    bonjourName: "localhub-test.local",
    port: memberPort,
  });

  await expect(
    serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      stateDirectory,
      startupDeadlineMs: 2_000,
      stopDeadlineMs: 500,
      member,
      currentInterfaces: () => [selected],
      publishBonjour: async () => {
        throw new Error("controlled mDNS publication failure");
      },
    }),
  ).rejects.toThrow("controlled mDNS publication failure");

  const failed = await waitForState(stateDirectory, "failed");
  expect(failed.member).toMatchObject({ health: "closed", bonjourPublished: false });
  expect(failed.failure).toMatchObject({
    cause: expect.stringContaining("controlled mDNS publication failure"),
    protectedState: expect.any(String),
    stillWorks: expect.any(String),
    repair: expect.any(String),
    recheck: expect.any(String),
  });
  await expect(fetch(member.ipv4Url)).rejects.toThrow();
});

macOSProcessTest(
  "network change and wake withdraw Member access until explicit same-interface recheck",
  async () => {
    const selected = currentPrivateInterfaces()[0];
    if (!selected) throw new Error("The supported macOS test lane has no private interface.");
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 });
    const [hostPort, llamaPort, memberPort] = await Promise.all([
      availablePort(),
      availablePort(),
      availablePortOn(selected.address),
    ]);
    const binding = await createMemberBinding({
      selected,
      available: [selected],
      bonjourName: "localhub-test.local",
      port: memberPort,
    });
    let visibleInterfaces = [selected];
    let publicationStops = 0;
    let observedTime = 0;
    const physicalPeer = physicalPeerFor(selected);
    const supervisor = serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      stateDirectory,
      startupDeadlineMs: 2_000,
      stopDeadlineMs: 500,
      member: binding,
      currentInterfaces: () => visibleInterfaces,
      memberCheckIntervalMs: 10,
      memberWakeGapMs: 50,
      now: () => observedTime,
      memberPeerAddress: () => physicalPeer,
      publishBonjour: async () => ({
        exited: new Promise<Error | null>(() => undefined),
        async stop() {
          publicationStops += 1;
        },
      }),
    });
    const running = await waitForState(stateDirectory, "running");
    try {
      expect(running.member).toMatchObject({ health: "recheck-required" });
      await expect(
        startLocalHubRun({
          buildCommit: running.commit,
          candidateRecordPath: "/not-used-for-existing-run",
          executablePath: "/not-used-for-existing-run",
          stateDirectory,
          startupDeadlineMs: 20,
          member: {
            interface: binding.interface,
            bonjourName: binding.bonjourName,
            port: binding.port,
          },
        }),
      ).rejects.toThrow("physical Member verification is still pending");
      const afterTimeout = await readRunState(stateDirectory);
      expect(afterTimeout?.runId).toBe(running.runId);
      expect(afterTimeout?.supervisor.pid).toBe(running.supervisor.pid);
      expect(afterTimeout?.member?.health).toBe("recheck-required");

      const pendingDashboard = await fetch(running.host.origin).then((response) => response.text());
      expect(pendingDashboard).toContain("Member verification pending");
      expect(pendingDashboard).toContain("Cause:");
      expect(pendingDashboard).toContain("Protected state:");
      expect(pendingDashboard).toContain("Repair:");
      expect(pendingDashboard).toContain("Recheck:");
      const pendingMember = await fetch(binding.ipv4Url, {
        headers: { host: new URL(binding.friendlyUrl).host },
      }).then((response) => response.text());
      expect(pendingMember).toContain("reachable for verification");
      expect(pendingMember).not.toContain("Member Link ready");
      const resumed = startLocalHubRun({
        buildCommit: running.commit,
        candidateRecordPath: "/not-used-for-existing-run",
        executablePath: "/not-used-for-existing-run",
        stateDirectory,
        startupDeadlineMs: 500,
        member: {
          interface: binding.interface,
          bonjourName: binding.bonjourName,
          port: binding.port,
        },
      });
      await fetch(binding.ipv4Url, {
        headers: { host: new URL(binding.ipv4Url).host },
      });
      const resumedRun = await resumed;
      expect(resumedRun.runId).toBe(running.runId);
      expect(resumedRun.supervisor.pid).toBe(running.supervisor.pid);

      const dashboard = await fetch(running.host.origin);
      const dashboardText = await dashboard.text();
      expect(dashboard.status).toBe(200);
      expect(dashboardText).toContain('href="/localhub.css"');
      expect(dashboardText).not.toContain("<style>");
      expect(
        await fetch(`${running.host.origin}/localhub.css`).then((response) => response.status),
      ).toBe(200);
      expect(
        await fetch(running.host.origin, { headers: { host: "attacker.invalid" } }).then(
          (response) => response.status,
        ),
      ).toBe(421);
      expect(
        await fetch(`${running.host.origin}/stop?run-id=${running.runId}`, {
          method: "POST",
        }).then((response) => response.status),
      ).toBe(409);
      expect(
        await fetch(`${running.host.origin}/stop?run-id=${running.runId}`, {
          method: "POST",
          headers: { origin: "https://attacker.invalid" },
        }).then((response) => response.status),
      ).toBe(409);

      visibleInterfaces = [];
      const withdrawn = await waitForMemberHealth(stateDirectory, "recheck-required");
      expect(withdrawn.member?.failure).toMatchObject({
        cause: expect.stringContaining("changed"),
        protectedState: expect.stringContaining("old Member Link is closed"),
        repair: expect.stringContaining("recheck"),
        recheck: expect.stringContaining("recheck"),
      });
      await expect(fetch(binding.ipv4Url)).rejects.toThrow();
      expect(await fetch(running.host.origin).then((response) => response.text())).not.toContain(
        binding.ipv4Url,
      );

      visibleInterfaces = [selected];
      const rechecked = await fetch(`${running.host.origin}/member/recheck`, {
        method: "POST",
        headers: { "x-localhub-run-id": running.runId },
      });
      expect(rechecked.status).toBe(202);
      expect((await rechecked.json()) as object).toMatchObject({
        status: "physical-verification-required",
        member: { health: "recheck-required", bonjourPublished: true },
      });
      await fetch(binding.ipv4Url, {
        headers: { host: new URL(binding.friendlyUrl).host },
      });
      expect((await readRunState(stateDirectory))?.member?.health).toBe("recheck-required");
      await fetch(binding.ipv4Url, {
        headers: { host: new URL(binding.ipv4Url).host },
      });
      await waitForMemberHealth(stateDirectory, "ready");

      observedTime = 100;
      const woke = await waitForMemberHealth(stateDirectory, "recheck-required");
      expect(woke.member?.failure).toMatchObject({
        cause: expect.stringContaining("wake or timer suspension"),
        protectedState: expect.stringContaining("closed"),
        repair: expect.any(String),
        recheck: expect.stringContaining("recheck"),
      });
      await expect(fetch(binding.ipv4Url)).rejects.toThrow();

      const wakeRecheck = await fetch(`${running.host.origin}/member/recheck`, {
        method: "POST",
        headers: { "x-localhub-run-id": running.runId },
      });
      expect(wakeRecheck.status).toBe(202);
      await provePhysicalMember(binding);
      await waitForMemberHealth(stateDirectory, "ready");
      await Bun.sleep(30);
      expect((await readRunState(stateDirectory))?.member?.health).toBe("ready");
    } finally {
      await fetch(`${running.host.origin}/stop`, {
        method: "POST",
        headers: { "x-localhub-run-id": running.runId },
      });
      await supervisor;
    }

    const stopped = await waitForState(stateDirectory, "stopped");
    expect(stopped.member).toMatchObject({ health: "closed", bonjourPublished: false });
    expect(publicationStops).toBe(3);
    await expect(fetch(binding.ipv4Url)).rejects.toThrow();
  },
);

macOSProcessTest("late Bonjour failure withdraws an already-verified Member Link", async () => {
  const selected = currentPrivateInterfaces()[0];
  if (!selected) throw new Error("The supported macOS test lane has no private interface.");
  const root = await isolatedRoot();
  const stateDirectory = join(root, "state");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const fakeLlama = join(runtimeDirectory, "llama-server");
  await writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 });
  const [hostPort, llamaPort, memberPort] = await Promise.all([
    availablePort(),
    availablePort(),
    availablePortOn(selected.address),
  ]);
  const binding = await createMemberBinding({
    selected,
    available: [selected],
    bonjourName: "localhub-test.local",
    port: memberPort,
  });
  let failBonjour!: (failure: Error | null) => void;
  let publicationStops = 0;
  const supervisor = serveLocalHubRun({
    bundle: bundle(fakeLlama),
    hostPort,
    llamaPort,
    stateDirectory,
    startupDeadlineMs: 2_000,
    stopDeadlineMs: 500,
    member: binding,
    currentInterfaces: () => [selected],
    memberPeerAddress: () => physicalPeerFor(selected),
    publishBonjour: async () => ({
      exited: new Promise<Error | null>((resolve) => {
        failBonjour = resolve;
      }),
      async stop() {
        publicationStops += 1;
      },
    }),
  });
  const running = await waitForState(stateDirectory, "running");
  try {
    await provePhysicalMember(binding);
    await waitForMemberHealth(stateDirectory, "ready");
    failBonjour(new Error("controlled late dns-sd exit"));
    const withdrawn = await waitForMemberHealth(stateDirectory, "recheck-required");
    expect(withdrawn.member?.failure?.cause).toContain("controlled late dns-sd exit");
    expect(publicationStops).toBe(1);
    await expect(fetch(binding.ipv4Url)).rejects.toThrow();
  } finally {
    await fetch(`${running.host.origin}/stop`, {
      method: "POST",
      headers: { "x-localhub-run-id": running.runId },
    });
    await supervisor;
  }
});

macOSProcessTest(
  "an in-flight physical visit cannot restore readiness after Bonjour withdrawal",
  async () => {
    const selected = currentPrivateInterfaces()[0];
    if (!selected) throw new Error("The supported macOS test lane has no private interface.");
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 });
    const [hostPort, llamaPort, memberPort] = await Promise.all([
      availablePort(),
      availablePort(),
      availablePortOn(selected.address),
    ]);
    const binding = await createMemberBinding({
      selected,
      available: [selected],
      bonjourName: "localhub-test.local",
      port: memberPort,
    });
    let failBonjour!: (failure: Error | null) => void;
    let enterIpv4Visit!: () => void;
    const ipv4VisitEntered = new Promise<void>((resolve) => {
      enterIpv4Visit = resolve;
    });
    let releaseIpv4Visit!: () => void;
    const ipv4VisitMayFinish = new Promise<void>((resolve) => {
      releaseIpv4Visit = resolve;
    });
    const supervisor = serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      stateDirectory,
      startupDeadlineMs: 2_000,
      stopDeadlineMs: 500,
      member: binding,
      currentInterfaces: () => [selected],
      memberPeerAddress: () => physicalPeerFor(selected),
      beforeMemberVisit: async (route) => {
        if (route === "ipv4") {
          enterIpv4Visit();
          await ipv4VisitMayFinish;
        }
      },
      publishBonjour: async () => ({
        exited: new Promise<Error | null>((resolve) => {
          failBonjour = resolve;
        }),
        async stop() {},
      }),
    });
    const running = await waitForState(stateDirectory, "running");
    try {
      await fetch(binding.ipv4Url, {
        headers: { host: new URL(binding.friendlyUrl).host },
      });
      const ipv4Visit = fetch(binding.ipv4Url, {
        headers: { host: new URL(binding.ipv4Url).host },
      }).catch(() => null);
      await ipv4VisitEntered;
      failBonjour(new Error("controlled withdrawal during physical visit"));
      await waitForMemberHealth(stateDirectory, "recheck-required");
      releaseIpv4Visit();
      await ipv4Visit;
      await Bun.sleep(50);
      expect((await readRunState(stateDirectory))?.member?.health).toBe("recheck-required");
    } finally {
      releaseIpv4Visit();
      await fetch(`${running.host.origin}/stop`, {
        method: "POST",
        headers: { "x-localhub-run-id": running.runId },
      });
      await supervisor;
    }
  },
);

macOSProcessTest(
  "fast physical visits cannot be overwritten by pending publication state",
  async () => {
    const selected = currentPrivateInterfaces()[0];
    if (!selected) throw new Error("The supported macOS test lane has no private interface.");
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 });
    const [hostPort, llamaPort, memberPort] = await Promise.all([
      availablePort(),
      availablePort(),
      availablePortOn(selected.address),
    ]);
    const binding = await createMemberBinding({
      selected,
      available: [selected],
      bonjourName: "localhub-test.local",
      port: memberPort,
    });
    let finishPublication!: () => void;
    const publicationMayFinish = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    const supervisor = serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      stateDirectory,
      startupDeadlineMs: 2_000,
      stopDeadlineMs: 500,
      member: binding,
      currentInterfaces: () => [selected],
      memberPeerAddress: () => physicalPeerFor(selected),
      publishBonjour: async () => {
        await publicationMayFinish;
        return {
          exited: new Promise<Error | null>(() => undefined),
          async stop() {},
        };
      },
    });

    await waitForMemberRequest(binding, new URL(binding.friendlyUrl).host);
    await waitForMemberRequest(binding, new URL(binding.ipv4Url).host);
    finishPublication();
    const running = await waitForState(stateDirectory, "running");
    await waitForMemberHealth(stateDirectory, "ready");
    try {
      expect((await readRunState(stateDirectory))?.member?.health).toBe("ready");
    } finally {
      await fetch(`${running.host.origin}/stop`, {
        method: "POST",
        headers: { "x-localhub-run-id": running.runId },
      });
      await supervisor;
    }
  },
);

macOSProcessTest(
  "a macOS worker crash fails closed with no hidden restart or orphan listener",
  async () => {
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(fakeLlama, fakeLlamaSource(), { mode: 0o755 });
    const [hostPort, llamaPort] = await Promise.all([availablePort(), availablePort()]);

    const crashed = serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      stateDirectory,
      startupDeadlineMs: 2_000,
      stopDeadlineMs: 500,
    });
    const initial = await withDeadline(
      waitForState(stateDirectory, "running"),
      "waiting for initial running state",
    );
    if (initial.llama.pid === null) throw new Error("Missing fake llama.cpp PID.");
    process.kill(initial.llama.pid, "SIGKILL");
    const failed = await withDeadline(
      waitForState(stateDirectory, "failed"),
      "waiting for crash failure state",
    );
    expect(failed.restartAttempts).toBe(0);
    expect(failed.acceptingWork).toBe(false);
    expect(failed.failure?.repair).toContain("run `lh stop`");
    const stoppedByPublicCommand = await withDeadline(
      captureOutput(() =>
        main(["stop"], {
          runStateDirectory: stateDirectory,
          stopRun: (options) =>
            stopLocalHubRun({
              ...options,
              stopDeadlineMs: 500,
              processAlive: (pid) => (pid === process.pid ? false : processIsAlive(pid)),
            }),
        }),
      ),
      "running public stop after crash",
    );
    expect(stoppedByPublicCommand.code).toBe(0);
    expect(stoppedByPublicCommand.output.join("\n")).toContain('"status": "stopped"');
    await withDeadline(crashed, "awaiting supervisor cleanup after crash stop");
    await withDeadline(waitForListenerClosed(initial.host.origin), "closing crashed Host listener");
    await withDeadline(
      waitForListenerClosed(initial.llama.origin),
      "closing crashed llama listener",
    );
    const final = await withDeadline(
      waitForState(stateDirectory, "stopped"),
      "waiting for final stopped state",
    );
    expect(final.host.health).toBe("closed");
    expect(final.llama.health).toBe("closed");
    expect(final.stop).toEqual({ activeWork: 0, forcedProcesses: [] });
  },
);

function bundle(llamaServerPath: string): RunBundle {
  return {
    candidateId: "localhub-0.1.1-aaaaaaaaaaaa-darwin-arm64",
    commit: "a".repeat(40),
    executable: { path: "lh", size: 100, sha256: "1".repeat(64) },
    llama: {
      archiveDigest: `sha256:${"2".repeat(64)}`,
      binary: { path: "runtime/llama.cpp/llama-server", size: 100, sha256: "3".repeat(64) },
      binaryPath: llamaServerPath,
      build: "b10107",
      commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
    },
  };
}

function runningState(): LocalHubRunState {
  return {
    schema: RUN_STATE_SCHEMA,
    runId: "run-identity",
    candidateId: "candidate",
    commit: "a".repeat(40),
    status: "running",
    acceptingWork: true,
    restartAttempts: 0,
    supervisor: { pid: 101, startedAt: "2026-07-27T18:00:00.000Z" },
    host: { origin: "http://127.0.0.1:39281", health: "ready" },
    llama: {
      pid: 102,
      origin: "http://127.0.0.1:39282",
      build: "b10107",
      commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
      architecture: "arm64",
      archiveDigest: `sha256:${"2".repeat(64)}`,
      binary: { path: "runtime/llama.cpp/llama-server", size: 100, sha256: "3".repeat(64) },
      devices: ["Metal: Apple test GPU"],
      launch: ["$CANDIDATE/runtime/llama.cpp/llama-server"],
      listener: "127.0.0.1:39282",
      health: "ready",
      model: null,
      runProfile: null,
      automaticFit: false,
      modelAutoload: false,
      builtInTools: false,
      builtInAgent: false,
      webUi: false,
      mcpProxy: false,
    },
    activeWork: 0,
    failure: null,
    stop: null,
    updatedAt: "2026-07-27T18:00:00.000Z",
  };
}

async function isolatedRoot(): Promise<string> {
  const parent = join(process.cwd(), "dist", "test-tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-"));
  testRoots.push(root);
  return root;
}

async function availablePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a test port.");
  return port;
}

async function availablePortOn(hostname: string): Promise<number> {
  const server = Bun.serve({ hostname, port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a selected-interface test port.");
  return port;
}

async function provePhysicalMember(binding: MemberBinding): Promise<void> {
  for (const host of [new URL(binding.friendlyUrl).host, new URL(binding.ipv4Url).host]) {
    const response = await fetch(binding.ipv4Url, { headers: { host } });
    expect(response.status).toBe(200);
  }
}

async function waitForMemberRequest(binding: MemberBinding, host: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(binding.ipv4Url, {
        headers: { host },
        signal: AbortSignal.timeout(100),
      });
      if (response.status === 200) return;
    } catch {
      // The selected-interface readiness listener has not opened yet.
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the selected-interface readiness listener.");
}

function physicalPeerFor(selected: PrivateInterface): string {
  const parts = selected.address.split(".").map(Number);
  for (let suffix = 2; suffix < 255; suffix += 1) {
    const candidate = `${parts[0]}.${parts[1]}.${parts[2]}.${suffix}`;
    if (candidate !== selected.address && isPeerOnSelectedSubnet(candidate, selected)) {
      return candidate;
    }
  }
  throw new Error("The selected test interface has no synthetic same-subnet physical peer.");
}

async function waitForState(
  stateDirectory: string,
  expected: LocalHubRunState["status"],
  deadlineMs = 3_000,
): Promise<LocalHubRunState> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(join(stateDirectory, "run-state.json"), "utf8"));
      if (state.status === expected) {
        return state;
      }
    } catch {
      // The supervisor has not committed state yet.
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${expected} run state.`);
}

async function waitForMemberHealth(
  stateDirectory: string,
  expected: NonNullable<LocalHubRunState["member"]>["health"],
  deadlineMs = 3_000,
): Promise<LocalHubRunState> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(join(stateDirectory, "run-state.json"), "utf8"));
      if (state.member?.health === expected) return state;
    } catch {
      // The supervisor has not committed the Member state yet.
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${expected} Member health.`);
}

async function waitForListenerClosed(origin: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(100) });
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Listener remained open: ${origin}`);
}

async function withDeadline<T>(promise: Promise<T>, checkpoint: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(2_000).then(() => {
      throw new Error(`Crash test stalled while ${checkpoint}.`);
    }),
  ]);
}

function fakeLlamaSource(
  options: { healthStatus?: number; preflightLockPath?: string; versionDelayMs?: number } = {},
): string {
  return `#!/usr/bin/env bun
import { readdir, rm, writeFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
const lockPath = ${JSON.stringify(options.preflightLockPath ?? null)};
const versionDelayMs = ${options.versionDelayMs ?? 0};
if (args.includes("--version")) {
  if (lockPath) {
    await writeFile(lockPath, "version");
    await Bun.sleep(100);
  }
  if (versionDelayMs > 0) await Bun.sleep(versionDelayMs);
  if (lockPath) {
    await rm(lockPath, { force: true });
  }
  console.log("version: 10107 (c0bc8591e)");
  process.exit(0);
}
if (args.includes("--list-devices")) {
  if (lockPath) {
    await Bun.sleep(25);
    if (await Bun.file(lockPath).exists()) {
      console.error("concurrent runtime preflight");
      process.exit(9);
    }
  }
  console.log("Metal: Apple test GPU");
  process.exit(0);
}
const value = (name) => args[args.indexOf(name) + 1];
async function ggufs(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = path + "/" + entry.name;
    if (entry.isDirectory()) found.push(...await ggufs(child));
    else if (entry.name.toLowerCase().endsWith(".gguf")) found.push(child);
  }
  return found;
}
const server = Bun.serve({
  hostname: value("--host"),
  port: Number(value("--port")),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok" }, { status: ${options.healthStatus ?? 200} });
    if (path === "/slots") return Response.json([]);
    if (path === "/models") return Response.json({ object: "list", data: await ggufs(value("--models-dir")) });
    return new Response("Not found", { status: 404 });
  },
});
const stop = async () => { await server.stop(true); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
}

async function captureOutput(run: () => Promise<number>): Promise<{
  code: number;
  output: string[];
  errors: string[];
}> {
  const originalLog = console.log;
  const originalError = console.error;
  const output: string[] = [];
  const errors: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    return { code: await run(), output, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
