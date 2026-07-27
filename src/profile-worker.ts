import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import type { InstalledModel } from "./model-acquisition.ts";
import {
  profileLaunchCommand,
  type CurrentProfileBinding,
  type ProfileTestObservation,
  type RunProfileRevision,
  type RunProfileRuntime,
} from "./run-profile.ts";

type CommandResult = { code: number; stdout: string; stderr: string };
type WorkerCommand = (command: string[], environment: NodeJS.ProcessEnv) => Promise<CommandResult>;

export interface ProfileWorkerProcess {
  pid: number;
  exited: Promise<number>;
  logs: Promise<string>;
  stop(deadlineMs: number): Promise<{ graceful: boolean; code: number }>;
}

export interface ProfileWorkerTransport {
  waitForHealth(origin: string, deadlineMs: number): Promise<void>;
  props(origin: string): Promise<{
    modelPath: string;
    modelAlias: string;
    totalSlots: number;
    chatTemplate: string;
    endpointSlots: boolean;
    endpointMetrics: boolean;
    endpointProps: boolean;
    ui: boolean;
  }>;
  slots(origin: string): Promise<Array<{ id: number; state: string; contextSize: number }>>;
  metrics(origin: string): Promise<void>;
  authority(origin: string): Promise<{ builtInTools: boolean; builtInAgent: boolean }>;
  text(origin: string): Promise<{
    outputTokens: number;
    firstTokenTimeMs: number;
    throughput: number;
  }>;
  cancel(
    origin: string,
    deadlineMs: number,
    expectedSlotIds: number[],
  ): Promise<{ passed: boolean; slotReleasedMs: number }>;
}

export interface ProfileWorkerDependencies {
  command?: WorkerCommand;
  environment?: NodeJS.ProcessEnv;
  binarySha256?: (path: string) => Promise<string>;
  host?: () => Promise<{ hardware: string; osVersion: string }>;
  now?: () => number;
  sampleResidentBytes?: (pid: number) => Promise<number>;
  sampleGpuBytes?: (pid: number) => Promise<number>;
  start?: (command: string[], environment: NodeJS.ProcessEnv) => Promise<ProfileWorkerProcess>;
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
  return profileLaunchCommand({
    binaryPath,
    revisionId: revision.id,
    model,
    port: String(port),
    controls: revision.controls,
    chatTemplate: revision.chatTemplate,
  });
}

export async function inspectCurrentProfileBinding(
  binaryPath: string,
  runtime: RunProfileRuntime,
  dependencies: ProfileWorkerDependencies = {},
): Promise<Extract<CurrentProfileBinding, { available: true }>> {
  const command = dependencies.command ?? runCommand;
  const environment = workerEnvironment(dependencies.environment ?? globalThis.process.env);
  const binarySha256 = await (dependencies.binarySha256 ?? sha256File)(binaryPath);
  if (binarySha256 !== runtime.binarySha256) {
    throw new Error("Profile Test llama.cpp binary hash did not match the exact revision.");
  }
  const [version, inventory, host] = await Promise.all([
    command([binaryPath, "--version"], environment),
    command([binaryPath, "--list-devices"], environment),
    dependencies.host ? dependencies.host() : inspectHost(command, environment),
  ]);
  if (
    version.code !== 0 ||
    !/version:\s*10107\b/.test(version.stdout + version.stderr) ||
    !(version.stdout + version.stderr).includes("c0bc8591e")
  ) {
    throw new Error("Profile Test runtime did not report pinned llama.cpp b10107 at c0bc8591e.");
  }
  if (inventory.code !== 0) throw new Error("Pinned llama.cpp device inventory failed.");
  const devices = deviceInventory(inventory.stdout + inventory.stderr);
  if (devices.length === 0) throw new Error("Pinned llama.cpp returned no device inventory.");
  return { available: true, runtime: structuredClone(runtime), host: { ...host, devices } };
}

export async function runProfileWorker(
  options: RunProfileWorkerOptions,
  dependencies: ProfileWorkerDependencies = {},
): Promise<ProfileTestObservation> {
  const now = dependencies.now ?? Date.now;
  const command = dependencies.command ?? runCommand;
  const environment = workerEnvironment(dependencies.environment ?? globalThis.process.env);
  let host = { hardware: "unavailable", osVersion: "unavailable" };
  const devices: string[] = [];
  const startupDeadlineMs = options.startupDeadlineMs ?? 10 * 60_000;
  const stopDeadlineMs = options.stopDeadlineMs ?? 10_000;
  const origin = `http://127.0.0.1:${options.port}`;
  const transport =
    dependencies.transport ?? createProfileWorkerTransport(now, options.revision.id);
  const effective = unobservedEffective(options.revision, options.model);
  let process: ProfileWorkerProcess | null = null;
  let surfacesPassed = false;
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
    const binding = await inspectCurrentProfileBinding(
      options.binaryPath,
      options.revision.runtime,
      dependencies,
    );
    host = binding.host;
    devices.push(...binding.host.devices);

    const launch = buildProfileWorkerCommand(
      options.binaryPath,
      options.revision,
      options.model,
      options.port,
    );
    const loadStartedAt = now();
    process = await (dependencies.start ?? startProfileProcess)(launch, environment);
    await transport.waitForHealth(origin, startupDeadlineMs);
    loadTimeMs = Math.max(0, now() - loadStartedAt);
    healthPassed = true;

    const props = await transport.props(origin);
    const modelFile = options.model.files.find((file) => file.role === "model");
    if (
      !modelFile ||
      props.modelPath !== modelFile.path ||
      props.modelAlias !== options.revision.id ||
      props.totalSlots !== options.revision.controls.parallelSlots ||
      createHash("sha256").update(props.chatTemplate).digest("hex") !==
        options.revision.chatTemplateSha256 ||
      !props.endpointSlots ||
      !props.endpointMetrics ||
      props.endpointProps ||
      props.ui
    ) {
      throw new Error(
        "Observed llama.cpp properties did not match the exact model, alias, template, slots, metrics, or disabled surfaces.",
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
    if (new Set(slots.map((slot) => slot.id)).size !== slots.length) {
      throw new Error("Observed llama.cpp slot identities were not unique.");
    }
    await transport.metrics(origin);
    const authority = await transport.authority(origin);
    if (authority.builtInTools || authority.builtInAgent) {
      throw new Error("Built-in tool or agent authority remained enabled.");
    }
    effective.contextPerSlot = slots[0]?.contextSize ?? 0;
    effective.slotCount = slots.length;
    effective.builtInTools = authority.builtInTools;
    effective.builtInAgent = authority.builtInAgent;
    surfacesPassed = true;
    peakRamBytes = Math.max(
      peakRamBytes,
      await (
        dependencies.sampleResidentBytes ?? ((pid) => residentBytes(pid, command, environment))
      )(process.pid),
    );
    peakGpuBytes = Math.max(
      peakGpuBytes,
      await (dependencies.sampleGpuBytes ?? ((pid) => gpuBytes(pid, command, environment)))(
        process.pid,
      ),
    );

    text = await transport.text(origin);
    peakRamBytes = Math.max(
      peakRamBytes,
      await (
        dependencies.sampleResidentBytes ?? ((pid) => residentBytes(pid, command, environment))
      )(process.pid),
    );
    peakGpuBytes = Math.max(
      peakGpuBytes,
      await (dependencies.sampleGpuBytes ?? ((pid) => gpuBytes(pid, command, environment)))(
        process.pid,
      ),
    );
    cancellation = await transport.cancel(
      origin,
      10_000,
      slots.map((slot) => slot.id),
    );
    peakRamBytes = Math.max(
      peakRamBytes,
      await (
        dependencies.sampleResidentBytes ?? ((pid) => residentBytes(pid, command, environment))
      )(process.pid),
    );
    peakGpuBytes = Math.max(
      peakGpuBytes,
      await (dependencies.sampleGpuBytes ?? ((pid) => gpuBytes(pid, command, environment)))(
        process.pid,
      ),
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
      if (surfacesPassed) {
        try {
          const observed = observedEffectiveSettings(logs, options.revision, devices);
          effective.controls = observed.controls;
          effective.kvLayout = observed.kvLayout;
          effective.placement = observed.placement;
          effective.automaticFit = false;
          loadPassed = true;
        } catch (error) {
          failure = [failure, errorMessage(error)].filter(Boolean).join(" ");
        }
      }
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

function unobservedEffective(
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
    builtInTools: true,
    builtInAgent: true,
    automaticFit: true,
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
      const modelAlias = stringValue(value.model_alias);
      const totalSlots = numberValue(value.total_slots);
      const chatTemplate = stringValue(value.chat_template);
      if (!modelAlias || totalSlots === null || !chatTemplate) {
        throw new Error("llama.cpp props omitted the effective alias, slot count, or template.");
      }
      return {
        modelPath,
        modelAlias,
        totalSlots,
        chatTemplate,
        endpointSlots: value.endpoint_slots === true,
        endpointMetrics: value.endpoint_metrics === true,
        endpointProps: value.endpoint_props === true,
        ui: value.ui === true,
      };
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
    async metrics(origin) {
      const response = await finiteFetch(`${origin}/metrics`, {}, 2_000);
      const body = await response.text();
      if (!response.ok || body.trim().length === 0) {
        throw new Error(`llama.cpp metrics proof returned HTTP ${response.status}.`);
      }
    },
    async authority(origin) {
      const tools = await finiteFetch(`${origin}/tools`, {}, 2_000);
      let toolDisabled = false;
      if (tools.status === 403) {
        const value = (await tools.json().catch(() => null)) as unknown;
        toolDisabled =
          isRecord(value) && isRecord(value.error) && value.error.type === "feature_disabled";
      }
      const agent = await finiteFetch(`${origin}/agent`, {}, 2_000);
      if (!toolDisabled || agent.status !== 404) {
        throw new Error("Built-in llama.cpp tools or agent route was not proven disabled.");
      }
      return { builtInTools: false, builtInAgent: false };
    },
    async cancel(origin, deadlineMs, expectedSlotIds) {
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
          if (exactSlotsIdle(slots, expectedSlotIds)) {
            return { passed: true, slotReleasedMs: Math.max(0, now() - cancelledAt) };
          }
        }
        await Bun.sleep(20);
      }
      return { passed: false, slotReleasedMs: deadlineMs + 1 };
    },
  };
}

export function exactSlotsIdle(value: unknown, expectedSlotIds: number[]): boolean {
  if (!Array.isArray(value) || expectedSlotIds.length === 0) return false;
  const expected = [...new Set(expectedSlotIds)].sort((left, right) => left - right);
  if (expected.length !== expectedSlotIds.length || value.length !== expected.length) return false;
  const actual: number[] = [];
  for (const slot of value) {
    if (!isRecord(slot) || !Number.isInteger(slot.id)) return false;
    if (slot.state !== "idle" && slot.is_processing !== false) return false;
    actual.push(Number(slot.id));
  }
  actual.sort((left, right) => left - right);
  return actual.every((id, index) => id === expected[index]);
}

async function streamedTextProof(
  origin: string,
  modelAlias: string,
  now: () => number,
): Promise<{ outputTokens: number; firstTokenTimeMs: number; throughput: number }> {
  const startedAt = now();
  const response = await fetch(`${origin}/v1/chat/completions`, {
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
    signal: AbortSignal.timeout(60_000),
  });
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

async function startProfileProcess(
  command: string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProfileWorkerProcess> {
  const child = Bun.spawn(command, {
    env: environment,
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
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function inspectHost(
  command: WorkerCommand,
  environment: NodeJS.ProcessEnv,
): Promise<{ hardware: string; osVersion: string }> {
  const [hardware, productVersion, buildVersion] = await Promise.all([
    command(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], environment),
    command(["/usr/bin/sw_vers", "-productVersion"], environment),
    command(["/usr/bin/sw_vers", "-buildVersion"], environment),
  ]);
  if (hardware.code !== 0 || productVersion.code !== 0 || buildVersion.code !== 0) {
    throw new Error("Profile Test could not record exact Host hardware and macOS version.");
  }
  return {
    hardware: hardware.stdout.trim(),
    osVersion: `macOS ${productVersion.stdout.trim()} (${buildVersion.stdout.trim()})`,
  };
}

async function residentBytes(
  pid: number,
  command: WorkerCommand,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const result = await command(["/bin/ps", "-o", "rss=", "-p", String(pid)], environment);
  const kib = Number(result.stdout.trim());
  return result.code === 0 && Number.isFinite(kib) && kib >= 0 ? Math.round(kib * 1024) : 0;
}

async function gpuBytes(
  pid: number,
  command: WorkerCommand,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  if (process.platform !== "darwin") return 0;
  const result = await command(["/usr/bin/footprint", "-p", String(pid)], environment);
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

function observedEffectiveSettings(
  logs: string,
  revision: RunProfileRevision,
  devices: string[],
): {
  controls: RunProfileRevision["controls"];
  kvLayout: "unified" | "per-slot";
  placement: string;
} {
  const controls = revision.controls;
  const placementMatch = logs.match(/llama_prepare_model_devices:\s+using device\s+([^\s(]+)/i);
  const placement = placementMatch?.[1] ?? (controls.gpuLayers === 0 ? "CPU" : "");
  const placementKnown =
    placement === "CPU" ||
    devices.some((device) => device === placement || device.startsWith(`${placement}:`));
  const offload = logs.match(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU/i);
  const gpuPlacementProven =
    controls.gpuLayers === 0 ||
    (placement.length > 0 &&
      placementKnown &&
      offload !== null &&
      Number(offload[1]) > 0 &&
      Number(offload[2]) >= Number(offload[1]));
  const context = observedInteger(logs, /llama_context:\s+n_ctx\s*=\s*(\d+)/i);
  const batch = observedInteger(logs, /llama_context:\s+n_batch\s*=\s*(\d+)/i);
  const microBatch = observedInteger(logs, /llama_context:\s+n_ubatch\s*=\s*(\d+)/i);
  const slotCount = observedInteger(logs, /n_slots\s*=\s*(\d+)/i);
  const contextPerSlot = observedInteger(logs, /n_ctx_slot\s*=\s*(\d+)/i);
  const threads = logs.match(/n_threads\s*=\s*(\d+)\s*\(n_threads_batch\s*=\s*(\d+)\)/i);
  const cache = logs.match(/K\s*\(([^)]+)\).*V\s*\(([^)]+)\)/i);
  const loadMode = logs.match(/load_mode\s*=\s*([A-Za-z]+)/i)?.[1]?.toLowerCase();
  const flashEnabled = /llama_context:\s+flash_attn\s*=\s*(?:enabled|true|1)/i.test(logs);
  const flashDisabled = /llama_context:\s+flash_attn\s*=\s*(?:disabled|false|0)/i.test(logs);
  const kvUnified = /(?:llama_context:|load_model:).*kv_unified\s*=\s*['"]?true/i.test(logs);
  const kvPerSlot = /(?:llama_context:|load_model:).*kv_unified\s*=\s*['"]?false/i.test(logs);
  const warmupProven = controls.warmup
    ? /warming up the model/i.test(logs)
    : !/warming up the model/i.test(logs);
  if (
    !gpuPlacementProven ||
    context !== controls.contextSize ||
    batch !== controls.batchSize ||
    microBatch !== controls.microBatchSize ||
    slotCount !== controls.parallelSlots ||
    contextPerSlot !== controls.contextSize ||
    Number(threads?.[1]) !== controls.threads ||
    Number(threads?.[2]) !== controls.threadsBatch ||
    cache?.[1]?.toLowerCase() !== controls.cacheTypeK.toLowerCase() ||
    cache?.[2]?.toLowerCase() !== controls.cacheTypeV.toLowerCase() ||
    loadMode !== controls.loadMode ||
    (controls.flashAttention === "on" ? !flashEnabled : !flashDisabled) ||
    (controls.kvUnified ? !kvUnified : !kvPerSlot) ||
    !warmupProven ||
    !/model loaded/i.test(logs)
  ) {
    throw new Error(
      "Pinned llama.cpp logs did not prove the exact effective placement and load settings.",
    );
  }
  return {
    controls: structuredClone(controls),
    kvLayout: controls.kvUnified ? "unified" : "per-slot",
    placement: placement || "CPU",
  };
}

function observedInteger(logs: string, pattern: RegExp): number | null {
  const value = Number(logs.match(pattern)?.[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
    .filter((line) => /Metal|MTL\d*|BLAS|CUDA|Vulkan|ROCm/i.test(line))
    .map((line) =>
      line
        .replace(/^[-*]\s*/, "")
        .replace(/\s+\([0-9.]+\s+MiB(?:,\s*[0-9.]+\s+MiB\s+free)?\)\s*$/i, ""),
    );
  return [...new Set(values)];
}

function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEM_VERSION_COMPAT"];
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
