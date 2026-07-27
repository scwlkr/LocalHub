import { expect, test } from "bun:test";
import type { InstalledModel } from "../src/model-acquisition.ts";
import {
  buildProfileWorkerCommand,
  exactSlotsIdle,
  runProfileWorker,
  type ProfileWorkerProcess,
} from "../src/profile-worker.ts";
import type { RunProfileRevision } from "../src/run-profile.ts";

test("the worker launches only the exact profile with fitting and built-in surfaces disabled", async () => {
  const revision = profileRevision();
  const model = installedModel();
  const command = buildProfileWorkerCommand("/candidate/llama-server", revision, model, 41000);

  for (const value of [
    "/candidate/llama-server",
    "--model",
    "/models/exact.gguf",
    "--host",
    "127.0.0.1",
    "--port",
    "41000",
    "--fit",
    "off",
    "--ctx-size",
    "4096",
    "--parallel",
    "2",
    "--kv-unified",
    "--log-verbosity",
    "5",
    "--log-colors",
    "off",
    "--no-webui",
    "--no-agent",
    "--no-ui-mcp-proxy",
  ]) {
    expect(command).toContain(value);
  }
  expect(command).not.toContain("--model-url");
  expect(command).not.toContain("--hf-repo");
  expect(command).not.toContain("--models-dir");
});

test("the real-worker seam records observed identity, slots, text, cancellation, resources, and stop", async () => {
  const revision = profileRevision();
  const model = installedModel();
  let launched: string[] = [];
  let stopped = false;
  const process: ProfileWorkerProcess = {
    pid: 321,
    exited: Promise.resolve(0),
    logs: Promise.resolve(observedLogs()),
    stop: async () => {
      stopped = true;
      return { graceful: true, code: 0 };
    },
  };

  const result = await runProfileWorker(
    {
      binaryPath: "/candidate/llama-server",
      model,
      port: 41000,
      revision,
    },
    {
      binarySha256: async () => "e".repeat(64),
      command: async (command) => {
        if (command[1] === "--version") {
          return { code: 0, stdout: "version: 10107 (c0bc8591e)", stderr: "" };
        }
        if (command[1] === "--list-devices") {
          return { code: 0, stdout: "MTL0: Apple M1 Max", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command.join(" ")}`);
      },
      host: async () => ({ hardware: "Apple M1 Max", osVersion: "macOS 27.0" }),
      now: (() => {
        let value = 1_000;
        return () => (value += 10);
      })(),
      sampleResidentBytes: async () => 640_000_000,
      sampleGpuBytes: async () => 0,
      start: async (command) => {
        launched = command;
        return process;
      },
      transport: {
        waitForHealth: async () => undefined,
        props: async () => observedProps(revision),
        slots: async () => [
          { id: 0, state: "idle", contextSize: 4096 },
          { id: 1, state: "idle", contextSize: 4096 },
        ],
        text: async () => ({ outputTokens: 4, firstTokenTimeMs: 80, throughput: 15.5 }),
        cancel: async () => ({ passed: true, slotReleasedMs: 25 }),
        metrics: async () => undefined,
        authority: async () => ({ builtInTools: false, builtInAgent: false }),
      },
    },
  );

  expect(launched).toEqual(
    buildProfileWorkerCommand("/candidate/llama-server", revision, model, 41000),
  );
  expect(stopped).toBeTrue();
  expect(result).toMatchObject({
    revisionId: revision.id,
    effective: {
      modelId: model.id,
      contextPerSlot: 4096,
      slotCount: 2,
      kvLayout: "unified",
      placement: "MTL0",
      automaticFit: false,
      builtInTools: false,
      builtInAgent: false,
    },
    load: { passed: true },
    health: { passed: true },
    textResponse: { passed: true, outputTokens: 4 },
    cancellation: { passed: true, slotReleasedMs: 25 },
    stop: { passed: true, graceful: true },
    resources: { peakRamBytes: 640_000_000, peakGpuBytes: 348_127_232 },
    performance: {
      loadTimeMs: 10,
      firstTokenTimeMs: 80,
      throughputTokensPerSecond: 15.5,
    },
    optionalCapabilities: {
      imageInput: "Unavailable",
      browserTools: "Unavailable",
      toolRunnerFunctions: "Unavailable",
    },
    failure: null,
  });
});

test("worker failure remains an exact failed observation and still stops its process", async () => {
  const revision = profileRevision();
  const model = installedModel();
  let stopped = false;
  const result = await runProfileWorker(
    { binaryPath: "/candidate/llama-server", model, port: 41000, revision },
    {
      binarySha256: async () => "e".repeat(64),
      command: async (command) => ({
        code: 0,
        stdout: command[1] === "--version" ? "version: 10107 (c0bc8591e)" : "Metal: Metal",
        stderr: "",
      }),
      host: async () => ({ hardware: "Apple M1 Max", osVersion: "macOS 27.0" }),
      now: () => 1_000,
      sampleResidentBytes: async () => 0,
      start: async () => ({
        pid: 321,
        exited: Promise.resolve(1),
        logs: Promise.resolve("model load failed"),
        stop: async () => {
          stopped = true;
          return { graceful: true, code: 1 };
        },
      }),
      transport: {
        waitForHealth: async () => {
          throw new Error("load rejected the exact architecture");
        },
        props: async () => ({ ...observedProps(revision), modelPath: "/other/similar.gguf" }),
        slots: async () => [],
        text: async () => ({ outputTokens: 0, firstTokenTimeMs: 0, throughput: 0 }),
        cancel: async () => ({ passed: false, slotReleasedMs: 10_001 }),
        metrics: async () => undefined,
        authority: async () => ({ builtInTools: false, builtInAgent: false }),
      },
    },
  );

  expect(stopped).toBeTrue();
  expect(result).toMatchObject({
    load: { passed: false },
    health: { passed: false },
    textResponse: { passed: false, outputTokens: 0 },
    cancellation: { passed: false },
    failure: expect.stringContaining("load rejected the exact architecture"),
  });
});

test("Apple device inventory accepts the exact b10107 MTL label", async () => {
  const revision = profileRevision();
  const model = installedModel();
  const result = await runProfileWorker(
    { binaryPath: "/candidate/llama-server", model, port: 41000, revision },
    {
      binarySha256: async () => "e".repeat(64),
      command: async (command) => ({
        code: 0,
        stdout:
          command[1] === "--version"
            ? "version: 10107 (c0bc8591e)"
            : "Available devices:\n  MTL0: Apple M1 Max\n  BLAS: Accelerate",
        stderr: "",
      }),
      host: async () => ({ hardware: "Apple M1 Max", osVersion: "macOS 27.0" }),
      now: () => 1_000,
      sampleGpuBytes: async () => 1,
      sampleResidentBytes: async () => 1,
      start: async () => ({
        pid: 321,
        exited: Promise.resolve(0),
        logs: Promise.resolve(observedLogs()),
        stop: async () => ({ graceful: true, code: 0 }),
      }),
      transport: {
        waitForHealth: async () => undefined,
        props: async () => observedProps(revision),
        slots: async () => [
          { id: 0, state: "idle", contextSize: 4096 },
          { id: 1, state: "idle", contextSize: 4096 },
        ],
        text: async () => ({ outputTokens: 1, firstTokenTimeMs: 1, throughput: 1 }),
        cancel: async () => ({ passed: true, slotReleasedMs: 1 }),
        metrics: async () => undefined,
        authority: async () => ({ builtInTools: false, builtInAgent: false }),
      },
    },
  );

  expect(result.effective.placement).toBe("MTL0");
  expect(result.host.devices).toContain("MTL0: Apple M1 Max");
});

test("current Host proof uses trusted tools and strips loader and llama configuration overrides", async () => {
  const revision = profileRevision();
  const model = installedModel();
  const commands: string[][] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const result = await runProfileWorker(
    { binaryPath: "/candidate/llama-server", model, port: 41000, revision },
    {
      environment: {
        PATH: "/hostile/bin",
        LANG: "C",
        HOME: "/hostile/home",
        DYLD_INSERT_LIBRARIES: "/hostile/inject.dylib",
        DYLD_LIBRARY_PATH: "/hostile/libs",
        LLAMA_ARG_AGENT: "1",
        LLAMA_ARG_MODEL: "/other/model.gguf",
      },
      binarySha256: async () => "e".repeat(64),
      command: async (command, environment) => {
        commands.push(command);
        environments.push(environment);
        if (command[0] === "/usr/sbin/sysctl") {
          return { code: 0, stdout: "Apple M1 Max\n", stderr: "" };
        }
        if (command[0] === "/usr/bin/sw_vers") {
          return {
            code: 0,
            stdout: command[1] === "-productVersion" ? "27.0\n" : "26A5388g\n",
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout:
            command[1] === "--version"
              ? "version: 10107 (c0bc8591e)"
              : "MTL0: Apple M1 Max (53084 MiB, 50000 MiB free)\nBLAS: Accelerate",
          stderr: "",
        };
      },
      sampleGpuBytes: async () => 1,
      sampleResidentBytes: async () => 1,
      start: async (_command, environment) => {
        environments.push(environment);
        return {
          pid: 321,
          exited: Promise.resolve(0),
          logs: Promise.resolve(observedLogs()),
          stop: async () => ({ graceful: true, code: 0 }),
        };
      },
      transport: passingTransport(revision),
    },
  );

  expect(result.failure).toBeNull();
  expect(commands).toContainEqual(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]);
  expect(commands).toContainEqual(["/usr/bin/sw_vers", "-productVersion"]);
  expect(environments.length).toBeGreaterThan(0);
  for (const environment of environments) {
    expect(environment.PATH).toBe("/hostile/bin");
    expect(environment.HOME).toBeUndefined();
    expect(environment.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(environment.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(environment.LLAMA_ARG_AGENT).toBeUndefined();
    expect(environment.LLAMA_ARG_MODEL).toBeUndefined();
  }
  expect(result.host.devices).toEqual(["MTL0: Apple M1 Max", "BLAS: Accelerate"]);
});

test("cancellation never accepts an empty or substituted slot inventory", () => {
  expect(exactSlotsIdle([], [0, 1])).toBeFalse();
  expect(exactSlotsIdle([{ id: 0, state: "idle" }], [0, 1])).toBeFalse();
  expect(
    exactSlotsIdle(
      [
        { id: 0, state: "idle" },
        { id: 2, state: "idle" },
      ],
      [0, 1],
    ),
  ).toBeFalse();
  expect(
    exactSlotsIdle(
      [
        { id: 0, state: "idle" },
        { id: 1, is_processing: false },
      ],
      [0, 1],
    ),
  ).toBeTrue();
});

test("missing effective-setting proof makes the exact Profile Test fail", async () => {
  const revision = profileRevision();
  const result = await runProfileWorker(
    {
      binaryPath: "/candidate/llama-server",
      model: installedModel(),
      port: 41000,
      revision,
    },
    {
      binarySha256: async () => "e".repeat(64),
      command: async (command) => ({
        code: 0,
        stdout: command[1] === "--version" ? "version: 10107 (c0bc8591e)" : "MTL0: Apple M1 Max",
        stderr: "",
      }),
      host: async () => ({ hardware: "Apple M1 Max", osVersion: "macOS 27.0" }),
      sampleGpuBytes: async () => 0,
      sampleResidentBytes: async () => 1,
      start: async () => ({
        pid: 321,
        exited: Promise.resolve(0),
        logs: Promise.resolve(observedLogs().replace("llama_context: n_batch = 512\n", "")),
        stop: async () => ({ graceful: true, code: 0 }),
      }),
      transport: passingTransport(revision),
    },
  );

  expect(result.load.passed).toBeFalse();
  expect(result.effective.placement).toBe("unobserved");
  expect(result.failure).toContain("did not prove the exact effective placement and load settings");
});

function observedProps(revision: RunProfileRevision) {
  return {
    modelPath: "/models/exact.gguf",
    modelAlias: revision.id,
    totalSlots: revision.controls.parallelSlots,
    chatTemplate: revision.chatTemplate,
    endpointSlots: true,
    endpointMetrics: true,
    endpointProps: false,
    ui: false,
  };
}

function passingTransport(revision: RunProfileRevision) {
  return {
    waitForHealth: async () => undefined,
    props: async () => observedProps(revision),
    slots: async () => [
      { id: 0, state: "idle", contextSize: 4096 },
      { id: 1, state: "idle", contextSize: 4096 },
    ],
    text: async () => ({ outputTokens: 1, firstTokenTimeMs: 1, throughput: 1 }),
    cancel: async () => ({ passed: true, slotReleasedMs: 1 }),
    metrics: async () => undefined,
    authority: async () => ({ builtInTools: false, builtInAgent: false }),
  };
}

function observedLogs(): string {
  return [
    "common_param: build 10107 (c0bc8591e)",
    "common_param: device MTL0: Apple M1 Max",
    "common_param: system_info: n_threads = 8 (n_threads_batch = 8)",
    "llama_prepare_model_devices: using device MTL0 (Apple M1 Max)",
    "load_tensors: loading model tensors (load_mode = mmap)",
    "load_tensors: offloaded 25/25 layers to GPU",
    "Metal0 model buffer size = 300.00 MiB",
    "Metal0 KV buffer size = 32.00 MiB",
    "llama_context: n_ctx = 4096",
    "llama_context: n_batch = 512",
    "llama_context: n_ubatch = 128",
    "llama_context: flash_attn = enabled",
    "llama_context: kv_unified = true",
    "llama_kv_cache: size = 12 MiB, K (f16): 6 MiB, V (f16): 6 MiB",
    "common_init_: warming up the model",
    "load_model: initializing, n_slots = 2, n_ctx_slot = 4096, kv_unified = 'true'",
    "llama_server: model loaded",
  ].join("\n");
}

function profileRevision(): RunProfileRevision {
  return {
    id: "revision-1",
    profileId: "profile-1",
    revision: 1,
    name: "Exact profile",
    modelId: "f".repeat(64),
    modelFiles: [{ role: "model", sha256: "a".repeat(64) }],
    runtime: {
      build: "b10107",
      commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
      binarySha256: "e".repeat(64),
    },
    chatTemplate: "{{ messages }}",
    chatTemplateSha256: Bun.CryptoHasher.hash("sha256", "{{ messages }}", "hex"),
    controls: {
      contextSize: 4096,
      parallelSlots: 2,
      kvUnified: true,
      batchSize: 512,
      microBatchSize: 128,
      gpuLayers: 99,
      threads: 8,
      threadsBatch: 8,
      flashAttention: "on",
      kvOffload: true,
      cacheTypeK: "f16",
      cacheTypeV: "f16",
      loadMode: "mmap",
      splitMode: "none",
      mainGpu: 0,
      continuousBatching: true,
      warmup: true,
    },
    estimates: { projectedRamBytes: null, projectedGpuBytes: null },
    renderedLaunchCommand: "exact command",
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

function installedModel(): InstalledModel {
  return {
    id: "f".repeat(64),
    displayName: "Exact model",
    available: true,
    architecture: "qwen2",
    parameterCount: 500_000_000,
    quantization: { fileType: 12, tensorTypes: { Q4_K: 1 } },
    trainingContext: 32_768,
    templateHints: ["{{ messages }}"],
    files: [
      {
        fileName: "exact.gguf",
        role: "model",
        path: "/models/exact.gguf",
        size: 400_000_000,
        sha256: "a".repeat(64),
        managed: true,
        shard: null,
      },
    ],
    acquiredAt: "2026-07-27T00:00:00.000Z",
  };
}
