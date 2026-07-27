import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import type { InstalledModel } from "./model-acquisition.ts";
import type { ProfileTestObservation, RunProfileRevision } from "./run-profile.ts";

export interface ProfileWorkerProcess {
  pid: number;
  exited: Promise<number>;
  logs: Promise<string>;
  stop(deadlineMs: number): Promise<{ graceful: boolean; code: number }>;
}

export interface ProfileWorkerTransport {
  waitForHealth(origin: string, deadlineMs: number): Promise<void>;
  props(origin: string): Promise<{ modelPath: string }>;
  slots(origin: string): Promise<Array<{ id: number; state: string; contextSize: number }>>;
  text(origin: string): Promise<{
    outputTokens: number;
    firstTokenTimeMs: number;
    throughput: number;
  }>;
  cancel(origin: string, deadlineMs: number): Promise<{ passed: boolean; slotReleasedMs: number }>;
}

export interface ProfileWorkerDependencies {
  command?: (command: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  binarySha256?: (path: string) => Promise<string>;
  host?: () => Promise<{ hardware: string; osVersion: string }>;
  now?: () => number;
  sampleResidentBytes?: (pid: number) => Promise<number>;
  sampleGpuBytes?: (pid: number) => Promise<number>;
  start?: (command: string[]) => Promise<ProfileWorkerProcess>;
  transport?: ProfileWorkerTransport;
}

export interface RunProfileWorkerOptions {
  binaryPath: string;
  revision: RunProfileRevision;
  model: InstalledModel;
  port: number;
  startupDeadlineMs?: number;
  stopDeadlineMs?: number;
}

export async function findProfileWorkerPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback Profile Test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export function buildProfileWorkerCommand(
  binaryPath: string,
  revision: RunProfileRevision,
  model: InstalledModel,
  port: number,
): string[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("Profile Test loopback port must be an integer from 1024 through 65535.");
  }
  if (model.id !== revision.modelId || !model.available) {
    throw new Error(
      `Exact Installed Model ${revision.modelId} is unavailable; no similarly named model was selected.`,
    );
  }
  const exactFiles = model.files.map(({ role, sha256 }) => ({ role, sha256 }));
  if (JSON.stringify(exactFiles) !== JSON.stringify(revision.modelFiles)) {
    throw new Error("Installed Model hashes do not match the exact Run Profile revision.");
  }
  const modelFile = model.files.find((file) => file.role === "model");
  if (!modelFile) throw new Error("Exact Installed Model has no model GGUF file.");
  const companion = model.files.find((file) => file.role === "companion");
  const controls = revision.controls;
  return [
    binaryPath,
    "--model",
    modelFile.path,
    ...(companion ? ["--mmproj", companion.path] : []),
    "--alias",
    revision.id,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--fit",
    "off",
    "--ctx-size",
    String(controls.contextSize),
    "--parallel",
    String(controls.parallelSlots),
    controls.kvUnified ? "--kv-unified" : "--no-kv-unified",
    "--batch-size",
    String(controls.batchSize),
    "--ubatch-size",
    String(controls.microBatchSize),
    "--gpu-layers",
    String(controls.gpuLayers),
    "--threads",
    String(controls.threads),
    "--threads-batch",
    String(controls.threadsBatch),
    "--flash-attn",
    controls.flashAttention,
    controls.kvOffload ? "--kv-offload" : "--no-kv-offload",
    "--cache-type-k",
    controls.cacheTypeK,
    "--cache-type-v",
    controls.cacheTypeV,
    "--load-mode",
    controls.loadMode,
    "--split-mode",
    controls.splitMode,
    "--main-gpu",
    String(controls.mainGpu),
    controls.continuousBatching ? "--cont-batching" : "--no-cont-batching",
    controls.warmup ? "--warmup" : "--no-warmup",
    "--metrics",
    "--slots",
    "--no-webui",
    "--no-agent",
    "--no-ui-mcp-proxy",
    "--cors-origins",
    "localhost",
    "--offline",
    "--chat-template",
    revision.chatTemplate,
  ];
}

export async function runProfileWorker(
  options: RunProfileWorkerOptions,
  dependencies: ProfileWorkerDependencies = {},
): Promise<ProfileTestObservation> {
  const now = dependencies.now ?? Date.now;
  const command = dependencies.command ?? runCommand;
  const host = await (dependencies.host ?? inspectHost)();
  const devices: string[] = [];
  const startupDeadlineMs = options.startupDeadlineMs ?? 10 * 60_000;
  const stopDeadlineMs = options.stopDeadlineMs ?? 10_000;
  const origin = `http://127.0.0.1:${options.port}`;
  const transport =
    dependencies.transport ?? createProfileWorkerTransport(now, options.revision.id);
  const effective = exactEffective(options.revision, options.model);
  let process: ProfileWorkerProcess | null = null;
  let loadPassed = false;
  let healthPassed = false;
  let text = { outputTokens: 0, firstTokenTimeMs: 0, throughput: 0 };
  let cancellation = { passed: false, slotReleasedMs: 10_001 };
  let peakRamBytes = 0;
  let peakGpuBytes = 0;
  let loadTimeMs = 0;
  let stop = { passed: false, graceful: false };
  let failure: string | null = null;
  let logs = "";

  try {
    const binarySha256 = await (dependencies.binarySha256 ?? sha256File)(options.binaryPath);
    if (binarySha256 !== options.revision.runtime.binarySha256) {
      throw new Error("Profile Test llama.cpp binary hash did not match the exact revision.");
    }
    const [version, inventory] = await Promise.all([
      command([options.binaryPath, "--version"]),
      command([options.binaryPath, "--list-devices"]),
    ]);
    if (
      version.code !== 0 ||
      !/version:\s*10107\b/.test(version.stdout + version.stderr) ||
      !(version.stdout + version.stderr).includes("c0bc8591e")
    ) {
      throw new Error("Profile Test runtime did not report pinned llama.cpp b10107 at c0bc8591e.");
    }
    if (inventory.code !== 0) throw new Error("Pinned llama.cpp device inventory failed.");
    devices.push(...deviceInventory(inventory.stdout + inventory.stderr));
    if (devices.length === 0) throw new Error("Pinned llama.cpp returned no device inventory.");

    const launch = buildProfileWorkerCommand(
      options.binaryPath,
      options.revision,
      options.model,
      options.port,
    );
    const loadStartedAt = now();
    process = await (dependencies.start ?? startProfileProcess)(launch);
    await transport.waitForHealth(origin, startupDeadlineMs);
    loadTimeMs = Math.max(0, now() - loadStartedAt);
    healthPassed = true;

    const props = await transport.props(origin);
    const modelFile = options.model.files.find((file) => file.role === "model");
    if (!modelFile || props.modelPath !== modelFile.path) {
      throw new Error(
        "Loaded model path did not match the exact Run Profile; no renamed or similarly named substitute was accepted.",
      );
    }
    const slots = await transport.slots(origin);
    if (
      slots.length !== options.revision.controls.parallelSlots ||
      slots.some((slot) => slot.contextSize !== options.revision.controls.contextSize)
    ) {
      throw new Error(
        "Observed slot count or per-slot Context Capacity did not match the revision.",
      );
    }
    effective.contextPerSlot = slots[0]?.contextSize ?? 0;
    effective.slotCount = slots.length;
    effective.placement = placement(devices);
    loadPassed = true;
    peakRamBytes = Math.max(
      peakRamBytes,
      await (dependencies.sampleResidentBytes ?? residentBytes)(process.pid),
    );
    peakGpuBytes = Math.max(
      peakGpuBytes,
      await (dependencies.sampleGpuBytes ?? gpuBytes)(process.pid),
    );

    text = await transport.text(origin);
    peakRamBytes = Math.max(
      peakRamBytes,
      await (dependencies.sampleResidentBytes ?? residentBytes)(process.pid),
    );
    peakGpuBytes = Math.max(
      peakGpuBytes,
      await (dependencies.sampleGpuBytes ?? gpuBytes)(process.pid),
    );
    cancellation = await transport.cancel(origin, 10_000);
    peakRamBytes = Math.max(
      peakRamBytes,
      await (dependencies.sampleResidentBytes ?? residentBytes)(process.pid),
    );
    peakGpuBytes = Math.max(
      peakGpuBytes,
      await (dependencies.sampleGpuBytes ?? gpuBytes)(process.pid),
    );
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    if (process) {
      const outcome = await process.stop(stopDeadlineMs).catch((error) => {
        failure = [failure, `Worker stop failed: ${errorMessage(error)}`].filter(Boolean).join(" ");
        return { graceful: false, code: 1 };
      });
      stop = { passed: outcome.graceful && outcome.code === 0, graceful: outcome.graceful };
      logs = await process.logs.catch(() => "");
      peakGpuBytes = Math.max(peakGpuBytes, observedGpuBytes(logs));
    }
  }

  const textPassed = text.outputTokens > 0 && text.firstTokenTimeMs >= 0 && text.throughput >= 0;
  if (
    !failure &&
    (!loadPassed || !healthPassed || !textPassed || !cancellation.passed || !stop.passed)
  ) {
    failure = "One or more exact worker behaviors failed; no fallback profile or model was used.";
  }
  return {
    revisionId: options.revision.id,
    effective,
    load: { passed: loadPassed },
    health: { passed: healthPassed },
    textResponse: { passed: textPassed, outputTokens: text.outputTokens },
    cancellation,
    stop,
    resources: { peakRamBytes, peakGpuBytes },
    performance: {
      loadTimeMs,
      firstTokenTimeMs: text.firstTokenTimeMs,
      throughputTokensPerSecond: text.throughput,
    },
    host: { ...host, devices },
    optionalCapabilities: {
      imageInput: "Unavailable",
      browserTools: "Unavailable",
      toolRunnerFunctions: "Unavailable",
    },
    failure,
  };
}

function exactEffective(
  revision: RunProfileRevision,
  model: InstalledModel,
): ProfileTestObservation["effective"] {
  return {
    modelId: model.id,
    modelFiles: model.files.map(({ role, sha256 }) => ({ role, sha256 })),
    runtime: structuredClone(revision.runtime),
    chatTemplateSha256: revision.chatTemplateSha256,
    controls: structuredClone(revision.controls),
    contextPerSlot: revision.controls.contextSize,
    slotCount: revision.controls.parallelSlots,
    kvLayout: revision.controls.kvUnified ? "unified" : "per-slot",
    placement: "unobserved",
    builtInTools: false,
    builtInAgent: false,
    automaticFit: false,
  };
}

function createProfileWorkerTransport(
  now: () => number,
  modelAlias: string,
): ProfileWorkerTransport {
  return {
    async waitForHealth(origin, deadlineMs) {
      const deadline = now() + deadlineMs;
      let last = "no response";
      while (now() < deadline) {
        try {
          const response = await finiteFetch(`${origin}/health`, {}, 1_000);
          if (response.ok) return;
          last = `HTTP ${response.status}`;
        } catch (error) {
          last = errorMessage(error);
        }
        await Bun.sleep(50);
      }
      throw new Error(`Exact Profile Test load/health deadline expired (${last}).`);
    },
    async props(origin) {
      const response = await finiteFetch(`${origin}/props`, {}, 2_000);
      if (!response.ok) throw new Error(`llama.cpp props returned HTTP ${response.status}.`);
      const value = (await response.json()) as Record<string, unknown>;
      const settings = isRecord(value.default_generation_settings)
        ? value.default_generation_settings
        : {};
      const modelPath =
        stringValue(value.model_path) ??
        stringValue(value.model) ??
        stringValue(settings.model_path) ??
        stringValue(settings.model);
      if (!modelPath) throw new Error("llama.cpp props omitted the effective model path.");
      return { modelPath };
    },
    async slots(origin) {
      const response = await finiteFetch(`${origin}/slots`, {}, 2_000);
      if (!response.ok) throw new Error(`llama.cpp slots returned HTTP ${response.status}.`);
      const value = await response.json();
      if (!Array.isArray(value)) throw new Error("llama.cpp slots response was malformed.");
      return value.map((slot, index) => {
        if (!isRecord(slot)) throw new Error("llama.cpp slot entry was malformed.");
        const id = numberValue(slot.id) ?? index;
        const state = stringValue(slot.state) ?? "unknown";
        const contextSize = numberValue(slot.n_ctx) ?? numberValue(slot.context_size);
        if (contextSize === null) throw new Error("llama.cpp slot omitted Context Capacity.");
        return { id, state, contextSize };
      });
    },
    async text(origin) {
      return await streamedTextProof(origin, modelAlias, now);
    },
    async cancel(origin, deadlineMs) {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]);
      const response = await fetch(`${origin}/completion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Continue this numbered list with short items: 1. one 2. two 3.",
          n_predict: 512,
          stream: true,
          temperature: 0,
        }),
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`llama.cpp cancellation proof returned HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      await reader.read();
      const cancelledAt = now();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      const deadline = cancelledAt + deadlineMs;
      while (now() < deadline) {
        const slotsResponse = await finiteFetch(`${origin}/slots`, {}, 1_000);
        if (slotsResponse.ok) {
          const slots = await slotsResponse.json();
          if (
            Array.isArray(slots) &&
            slots.every(
              (slot) => isRecord(slot) && (slot.state === "idle" || slot.is_processing === false),
            )
          ) {
            return { passed: true, slotReleasedMs: Math.max(0, now() - cancelledAt) };
          }
        }
        await Bun.sleep(20);
      }
      return { passed: false, slotReleasedMs: deadlineMs + 1 };
    },
  };
}

async function streamedTextProof(
  origin: string,
  modelAlias: string,
  now: () => number,
): Promise<{ outputTokens: number; firstTokenTimeMs: number; throughput: number }> {
  const startedAt = now();
  const response = await finiteFetch(
    `${origin}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelAlias,
        messages: [{ role: "user", content: "Reply with one short greeting." }],
        max_tokens: 16,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
    },
    60_000,
  );
  if (!response.ok || !response.body) {
    throw new Error(`llama.cpp text proof returned HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt: number | null = null;
  let outputTokens = 0;
  let predictedPerSecond: number | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const value = JSON.parse(line.slice(6)) as Record<string, unknown>;
      const choices = Array.isArray(value.choices) ? value.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) continue;
        const content = stringValue(choice.delta.content);
        if (content) {
          firstTokenAt ??= now();
          outputTokens += 1;
        }
      }
      if (isRecord(value.usage)) {
        outputTokens = numberValue(value.usage.completion_tokens) ?? outputTokens;
      }
      if (isRecord(value.timings)) {
        predictedPerSecond = numberValue(value.timings.predicted_per_second);
      }
    }
  }
  if (!firstTokenAt || outputTokens < 1) throw new Error("llama.cpp produced no basic text token.");
  const elapsedAfterFirst = Math.max(1, now() - firstTokenAt);
  return {
    outputTokens,
    firstTokenTimeMs: Math.max(0, firstTokenAt - startedAt),
    throughput: predictedPerSecond ?? (outputTokens * 1_000) / elapsedAfterFirst,
  };
}

async function startProfileProcess(command: string[]): Promise<ProfileWorkerProcess> {
  const child = Bun.spawn(command, {
    env: workerEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([stdout, stderr]) => `${stdout}\n${stderr}`);
  return {
    pid: child.pid,
    exited: child.exited,
    logs,
    async stop(deadlineMs) {
      child.kill("SIGTERM");
      const outcome = await Promise.race([
        child.exited.then((code) => ({ graceful: true, code })),
        Bun.sleep(deadlineMs).then(() => null),
      ]);
      if (outcome) return outcome;
      child.kill("SIGKILL");
      return { graceful: false, code: await child.exited };
    },
  };
}

async function runCommand(
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function inspectHost(): Promise<{ hardware: string; osVersion: string }> {
  const [hardware, productVersion, buildVersion] = await Promise.all([
    runCommand(["sysctl", "-n", "machdep.cpu.brand_string"]),
    runCommand(["sw_vers", "-productVersion"]),
    runCommand(["sw_vers", "-buildVersion"]),
  ]);
  if (hardware.code !== 0 || productVersion.code !== 0 || buildVersion.code !== 0) {
    throw new Error("Profile Test could not record exact Host hardware and macOS version.");
  }
  return {
    hardware: hardware.stdout.trim(),
    osVersion: `macOS ${productVersion.stdout.trim()} (${buildVersion.stdout.trim()})`,
  };
}

async function residentBytes(pid: number): Promise<number> {
  const result = await runCommand(["ps", "-o", "rss=", "-p", String(pid)]);
  const kib = Number(result.stdout.trim());
  return result.code === 0 && Number.isFinite(kib) && kib >= 0 ? Math.round(kib * 1024) : 0;
}

async function gpuBytes(pid: number): Promise<number> {
  if (process.platform !== "darwin") return 0;
  const result = await runCommand(["footprint", "-p", String(pid)]);
  if (result.code !== 0) return 0;
  let total = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!/IOAccelerator|IOSurface|graphics/i.test(line)) continue;
    const match = line.trim().match(/^([0-9.]+)\s*(B|KB|MB|GB)\b/i);
    if (!match) continue;
    total += bytesFromUnit(Number(match[1]), match[2] ?? "B");
  }
  return total;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function finiteFetch(url: string, init: RequestInit, deadlineMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const provided = init.signal;
  const abort = (): void => controller.abort();
  provided?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    provided?.removeEventListener("abort", abort);
  }
}

function observedGpuBytes(logs: string): number {
  const buffers = new Map<string, number>();
  for (const line of logs.split(/\r?\n/)) {
    const match = line.match(
      /([^|:]*Metal\d*[^|:]*)\s+([^:=]+?)\s+buffer size\s*=\s*([0-9.]+)\s*MiB/i,
    );
    if (!match) continue;
    const key = `${match[1]?.trim()}:${match[2]?.trim()}`;
    const mebibytes = Number(match[3]);
    if (Number.isFinite(mebibytes) && mebibytes >= 0) {
      buffers.set(key, Math.round(mebibytes * 1024 * 1024));
    }
  }
  return [...buffers.values()].reduce((total, value) => total + value, 0);
}

function bytesFromUnit(value: number, unit: string): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const multiplier =
    unit.toUpperCase() === "GB"
      ? 1024 ** 3
      : unit.toUpperCase() === "MB"
        ? 1024 ** 2
        : unit.toUpperCase() === "KB"
          ? 1024
          : 1;
  return Math.round(value * multiplier);
}

function deviceInventory(output: string): string[] {
  const values = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /Metal|CUDA|Vulkan|ROCm/i.test(line))
    .map((line) => line.replace(/^[-*]\s*/, ""));
  return [...new Set(values)];
}

function placement(devices: string[]): string {
  const first = devices[0] ?? "";
  const name = first.split(":")[0]?.trim();
  return name || first || "unobserved";
}

function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "DYLD_LIBRARY_PATH"];
  return Object.fromEntries(
    allowed.flatMap((name) => (typeof env[name] === "string" ? [[name, env[name]]] : [])),
  );
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
