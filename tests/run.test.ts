import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import {
  RUN_STATE_SCHEMA,
  buildLlamaLaunch,
  buildSupervisorLaunch,
  inspectLocalHubRun,
  serveLocalHubRun,
  stopLocalHubRun,
  writeRunState,
  type LocalHubRunState,
  type RunBundle,
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

test("the shipped CLI exposes explicit start/status/stop without replacing legacy status", async () => {
  const state = runningState();
  const calls: string[] = [];
  const start = await captureOutput(() =>
    main(["run", "start"], {
      buildCommit: "a".repeat(40),
      executablePath: "/candidate/lh",
      runCandidateRecordPath: "/candidate/release-candidate.json",
      runStateDirectory: "/state",
      startRun: async (options) => {
        calls.push(`start:${options.candidateRecordPath}:${options.stateDirectory}`);
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
  expect(calls).toEqual(["start:/candidate/release-candidate.json:/state", "stop"]);
  expect(start.output.join("\n")).toContain('"model": null');
  expect(status.output.join("\n")).toContain('"listener": "127.0.0.1:39282"');
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

macOSProcessTest(
  "the real macOS supervisor boundary reaches health, reports no model proof, then closes both listeners",
  async () => {
    const root = await isolatedRoot();
    const stateDirectory = join(root, "state");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    const fakeLlama = join(runtimeDirectory, "llama-server");
    await writeFile(
      fakeLlama,
      fakeLlamaSource({ preflightLockPath: join(root, "preflight.lock") }),
      {
        mode: 0o755,
      },
    );
    const [hostPort, llamaPort] = await Promise.all([availablePort(), availablePort()]);

    const supervisor = serveLocalHubRun({
      bundle: bundle(fakeLlama),
      hostPort,
      llamaPort,
      stateDirectory,
      startupDeadlineMs: 2_000,
      stopDeadlineMs: 2_000,
    });
    const running = await waitForState(stateDirectory, "running");
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
      repair: expect.stringContaining("pinned llama.cpp runtime"),
      recheck: "Run `lh run start`, then `lh run status`.",
    });
    expect(failed.restartAttempts).toBe(0);
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

async function waitForState(
  stateDirectory: string,
  expected: LocalHubRunState["status"],
): Promise<LocalHubRunState> {
  const deadline = Date.now() + 3_000;
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
  options: { healthStatus?: number; preflightLockPath?: string } = {},
): string {
  return `#!/usr/bin/env bun
import { rm, writeFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
const lockPath = ${JSON.stringify(options.preflightLockPath ?? null)};
if (args.includes("--version")) {
  if (lockPath) {
    await writeFile(lockPath, "version");
    await Bun.sleep(100);
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
const server = Bun.serve({
  hostname: value("--host"),
  port: Number(value("--port")),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok" }, { status: ${options.healthStatus ?? 200} });
    if (path === "/slots") return Response.json([]);
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
