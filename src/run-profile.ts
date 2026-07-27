import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type InstalledModel, inspectInstalledModels } from "./model-acquisition.ts";

export const RUN_PROFILE_STATE_SCHEMA = "localhub.run-profile-state/v1";

export interface RunProfileRuntime {
  build: "b10107";
  commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9";
  binarySha256: string;
}

export interface RunProfileControls {
  contextSize: number;
  parallelSlots: number;
  kvUnified: boolean;
  batchSize: number;
  microBatchSize: number;
  gpuLayers: number;
  threads: number;
  threadsBatch: number;
  flashAttention: "on" | "off";
  kvOffload: boolean;
  cacheTypeK: string;
  cacheTypeV: string;
  loadMode: "mmap" | "read" | "mlock";
  splitMode: "none" | "layer" | "row" | "tensor";
  mainGpu: number;
  continuousBatching: boolean;
  warmup: boolean;
}

export interface RunProfileEstimates {
  projectedRamBytes: number | null;
  projectedGpuBytes: number | null;
}

export interface RunProfileRevision {
  id: string;
  profileId: string;
  revision: number;
  name: string;
  modelId: string;
  modelFiles: Array<{ role: "model" | "companion"; sha256: string }>;
  runtime: RunProfileRuntime;
  chatTemplate: string;
  chatTemplateSha256: string;
  controls: RunProfileControls;
  estimates: RunProfileEstimates;
  renderedLaunchCommand: string;
  createdAt: string;
}

export type OptionalCapability = "imageInput" | "browserTools" | "toolRunnerFunctions";
export type CapabilityState = "Passed" | "Failed" | "Unavailable";

export interface ProfileTestObservation {
  revisionId: string;
  effective: {
    modelId: string;
    modelFiles: Array<{ role: "model" | "companion"; sha256: string }>;
    runtime: RunProfileRuntime;
    chatTemplateSha256: string;
    controls: RunProfileControls;
    contextPerSlot: number;
    slotCount: number;
    kvLayout: "unified" | "per-slot";
    placement: string;
    builtInTools: boolean;
    builtInAgent: boolean;
    automaticFit: boolean;
  };
  load: { passed: boolean };
  health: { passed: boolean };
  textResponse: { passed: boolean; outputTokens: number };
  cancellation: { passed: boolean; slotReleasedMs: number };
  stop: { passed: boolean; graceful: boolean };
  resources: { peakRamBytes: number; peakGpuBytes: number };
  performance: {
    loadTimeMs: number;
    firstTokenTimeMs: number;
    throughputTokensPerSecond: number;
  };
  host: { hardware: string; devices: string[]; osVersion: string };
  optionalCapabilities: Record<OptionalCapability, CapabilityState>;
  failure: string | null;
}

export interface ProfileResult {
  id: string;
  revisionId: string;
  outcome: "Passed" | "Failed";
  effective: ProfileTestObservation["effective"];
  capabilities: {
    text: CapabilityState;
    imageInput: CapabilityState;
    browserTools: CapabilityState;
    toolRunnerFunctions: CapabilityState;
  };
  measurements: {
    loadTimeMs: number;
    firstTokenTimeMs: number;
    throughputTokensPerSecond: number;
    peakRamBytes: number;
    peakGpuBytes: number;
  };
  load: ProfileTestObservation["load"];
  health: ProfileTestObservation["health"];
  textResponse: ProfileTestObservation["textResponse"];
  cancellation: ProfileTestObservation["cancellation"];
  stop: ProfileTestObservation["stop"];
  host: ProfileTestObservation["host"];
  failure: string | null;
  testedAt: string;
}

export interface SharedModelLimits {
  contextTokens: number;
  outputTokens: number;
  concurrentRequests: number;
}

export interface SharedModel {
  id: string;
  name: string;
  revisionId: string;
  limits: SharedModelLimits;
  capabilities: Array<"text" | OptionalCapability>;
  pinned: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptedSharedModelTarget {
  sharedModelId: string;
  revisionId: string;
  modelId: string;
  modelFiles: RunProfileRevision["modelFiles"];
  runtime: RunProfileRuntime;
  chatTemplateSha256: string;
  controls: RunProfileControls;
  limits: SharedModelLimits;
  capabilities: SharedModel["capabilities"];
  acceptedAt: string;
}

interface RunProfileState {
  schema: typeof RUN_PROFILE_STATE_SCHEMA;
  revisions: RunProfileRevision[];
  results: ProfileResult[];
  sharedModels: SharedModel[];
}

export interface RunProfileDependencies {
  inspectModels?: (storagePath: string) => Promise<InstalledModel[]>;
  now?: () => Date;
  randomId?: () => string;
}

export interface CreateRunProfileInput {
  name: string;
  modelId: string;
  runtime: RunProfileRuntime;
  chatTemplate: string;
  controls: RunProfileControls;
  estimates: RunProfileEstimates;
}

export async function createRunProfile(
  storagePath: string,
  input: CreateRunProfileInput,
  dependencies: RunProfileDependencies = {},
): Promise<RunProfileRevision> {
  return await mutateState(storagePath, async (state) => {
    const model = await exactAvailableModel(storagePath, input.modelId, dependencies);
    const name = nonEmpty(input.name, "Run Profile name");
    assertRuntime(input.runtime);
    const chatTemplate = nonEmpty(input.chatTemplate, "Chat template");
    assertControls(input.controls);
    assertEstimates(input.estimates);
    const profileId = allocateId(
      (dependencies.randomId ?? randomUUID)(),
      new Set(state.revisions.map((item) => item.profileId)),
    );
    const revision = makeRevision({
      profileId,
      revision: 1,
      name,
      model,
      runtime: input.runtime,
      chatTemplate,
      controls: input.controls,
      estimates: input.estimates,
      createdAt: now(dependencies),
    });
    state.revisions.push(revision);
    return revision;
  });
}

export async function reviseRunProfile(
  storagePath: string,
  previousRevisionId: string,
  changes: Partial<
    Pick<
      CreateRunProfileInput,
      "name" | "modelId" | "runtime" | "chatTemplate" | "controls" | "estimates"
    >
  >,
  dependencies: RunProfileDependencies = {},
): Promise<RunProfileRevision> {
  return await mutateState(storagePath, async (state) => {
    const previous = exactRevision(state, previousRevisionId);
    if (latestRevision(state, previous.profileId).id !== previous.id) {
      throw new Error(
        `Run Profile revision ${previous.id} is stale; revise the current exact revision.`,
      );
    }
    const model = await exactAvailableModel(
      storagePath,
      changes.modelId ?? previous.modelId,
      dependencies,
    );
    const candidate = makeRevision({
      profileId: previous.profileId,
      revision: previous.revision + 1,
      name: nonEmpty(changes.name ?? previous.name, "Run Profile name"),
      model,
      runtime: changes.runtime ?? previous.runtime,
      chatTemplate: nonEmpty(changes.chatTemplate ?? previous.chatTemplate, "Chat template"),
      controls: changes.controls ?? previous.controls,
      estimates: changes.estimates ?? previous.estimates,
      createdAt: now(dependencies),
    });
    if (sameBoundInputs(previous, candidate)) {
      throw new Error("Run Profile revision did not change any bound input.");
    }
    state.revisions.push(candidate);
    return candidate;
  });
}

export async function testRunProfile(
  storagePath: string,
  revisionId: string,
  observation: ProfileTestObservation,
  dependencies: RunProfileDependencies = {},
): Promise<ProfileResult> {
  return await mutateState(storagePath, async (state) => {
    const revision = exactRevision(state, revisionId);
    await exactAvailableModel(storagePath, revision.modelId, dependencies, revision.modelFiles);
    const mismatches = observationMismatches(revision, observation);
    const mandatoryPassed =
      observation.load.passed &&
      observation.health.passed &&
      observation.textResponse.passed &&
      observation.textResponse.outputTokens > 0 &&
      observation.cancellation.passed &&
      observation.cancellation.slotReleasedMs <= 10_000 &&
      observation.stop.passed &&
      observation.stop.graceful &&
      !observation.effective.automaticFit &&
      !observation.effective.builtInTools &&
      !observation.effective.builtInAgent &&
      observation.effective.contextPerSlot > 0 &&
      observation.effective.slotCount === revision.controls.parallelSlots &&
      Boolean(observation.effective.placement) &&
      validMeasurements(observation);
    const outcome = mismatches.length === 0 && mandatoryPassed ? "Passed" : "Failed";
    const failure =
      outcome === "Passed"
        ? null
        : [
            ...mismatches,
            ...(mandatoryPassed ? [] : ["One or more mandatory Profile Test behaviors failed."]),
            ...(observation.failure ? [observation.failure] : []),
          ].join(" ");
    const result: ProfileResult = {
      id: allocateId(
        (dependencies.randomId ?? randomUUID)(),
        new Set(state.results.map((item) => item.id)),
      ),
      revisionId,
      outcome,
      effective: structuredClone(observation.effective),
      capabilities: {
        text: observation.textResponse.passed ? "Passed" : "Failed",
        ...observation.optionalCapabilities,
      },
      measurements: {
        ...observation.performance,
        ...observation.resources,
      },
      load: observation.load,
      health: observation.health,
      textResponse: observation.textResponse,
      cancellation: observation.cancellation,
      stop: observation.stop,
      host: structuredClone(observation.host),
      failure,
      testedAt: now(dependencies),
    };
    state.results.push(result);
    return result;
  });
}

export async function inspectRunProfiles(
  storagePath: string,
  dependencies: RunProfileDependencies = {},
): Promise<{
  revisions: Array<RunProfileRevision & { evidenceState: EvidenceState }>;
  results: Array<ProfileResult & { evidenceState: EvidenceState }>;
  sharedModels: SharedModel[];
}> {
  const state = await readState(storagePath);
  const models = await (dependencies.inspectModels ?? inspectInstalledModels)(storagePath);
  const revisions = state.revisions.map((revision) => ({
    ...revision,
    evidenceState: evidenceState(state, revision, models),
  }));
  const results = state.results.map((result) => ({
    ...result,
    evidenceState: evidenceState(state, exactRevision(state, result.revisionId), models, result),
  }));
  return { revisions, results, sharedModels: state.sharedModels };
}

export async function publishSharedModel(
  storagePath: string,
  input: {
    name: string;
    revisionId: string;
    limits: SharedModelLimits;
    capabilities: SharedModel["capabilities"];
  },
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(storagePath, async (state) => {
    const revision = await currentlyPassingRevision(
      storagePath,
      state,
      input.revisionId,
      dependencies,
    );
    const name = nonEmpty(input.name, "Shared Model name");
    if (
      state.sharedModels.some(
        (item) => item.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
      )
    ) {
      throw new Error(`Shared Model name is already in use: ${name}`);
    }
    const result = passingResult(state, revision.id);
    assertLimits(input.limits, result.effective.contextPerSlot);
    assertExposedCapabilities(input.capabilities, result);
    const timestamp = now(dependencies);
    const shared: SharedModel = {
      id: allocateId(
        (dependencies.randomId ?? randomUUID)(),
        new Set(state.sharedModels.map((item) => item.id)),
      ),
      name,
      revisionId: revision.id,
      limits: structuredClone(input.limits),
      capabilities: [...input.capabilities],
      pinned: false,
      published: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.sharedModels.push(shared);
    return shared;
  });
}

export async function setSharedModelPin(
  storagePath: string,
  sharedModelId: string,
  pinned: boolean,
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(storagePath, async (state) => {
    const shared = exactSharedModel(state, sharedModelId);
    shared.pinned = pinned;
    shared.updatedAt = now(dependencies);
    return structuredClone(shared);
  });
}

export async function setSharedModelPublished(
  storagePath: string,
  sharedModelId: string,
  published: boolean,
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(storagePath, async (state) => {
    const shared = exactSharedModel(state, sharedModelId);
    if (published) {
      await currentlyPassingRevision(storagePath, state, shared.revisionId, dependencies);
    }
    shared.published = published;
    shared.updatedAt = now(dependencies);
    return structuredClone(shared);
  });
}

export async function replaceSharedModel(
  storagePath: string,
  sharedModelId: string,
  revisionId: string,
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(storagePath, async (state) => {
    const shared = exactSharedModel(state, sharedModelId);
    const revision = await currentlyPassingRevision(storagePath, state, revisionId, dependencies);
    const result = passingResult(state, revision.id);
    assertLimits(shared.limits, result.effective.contextPerSlot);
    assertExposedCapabilities(shared.capabilities, result);
    shared.revisionId = revision.id;
    shared.updatedAt = now(dependencies);
    return structuredClone(shared);
  });
}

export async function acceptSharedModelRequest(
  storagePath: string,
  sharedModelId: string,
  dependencies: RunProfileDependencies = {},
): Promise<AcceptedSharedModelTarget> {
  const state = await readState(storagePath);
  const shared = exactSharedModel(state, sharedModelId);
  if (!shared.published) {
    throw new Error(`Shared Model ${shared.id} is unshared and cannot accept new work.`);
  }
  const revision = await currentlyPassingRevision(
    storagePath,
    state,
    shared.revisionId,
    dependencies,
  );
  return {
    sharedModelId: shared.id,
    revisionId: revision.id,
    modelId: revision.modelId,
    modelFiles: structuredClone(revision.modelFiles),
    runtime: structuredClone(revision.runtime),
    chatTemplateSha256: revision.chatTemplateSha256,
    controls: structuredClone(revision.controls),
    limits: structuredClone(shared.limits),
    capabilities: [...shared.capabilities],
    acceptedAt: now(dependencies),
  };
}

type EvidenceState = "Untested" | "Passed" | "Failed" | "Stale" | "Missing";

function evidenceState(
  state: RunProfileState,
  revision: RunProfileRevision,
  models: InstalledModel[],
  selectedResult?: ProfileResult,
): EvidenceState {
  const model = models.find((item) => item.id === revision.modelId);
  if (!model?.available || !sameFiles(revision.modelFiles, model.files)) return "Missing";
  if (latestRevision(state, revision.profileId).id !== revision.id) return "Stale";
  const result = selectedResult ?? latestResult(state, revision.id);
  if (!result) return "Untested";
  return result.outcome;
}

async function currentlyPassingRevision(
  storagePath: string,
  state: RunProfileState,
  revisionId: string,
  dependencies: RunProfileDependencies,
): Promise<RunProfileRevision> {
  const revision = exactRevision(state, revisionId);
  if (latestRevision(state, revision.profileId).id !== revision.id) {
    throw new Error(`Run Profile revision ${revision.id} is stale and cannot accept new work.`);
  }
  await exactAvailableModel(storagePath, revision.modelId, dependencies, revision.modelFiles);
  if (latestResult(state, revision.id)?.outcome !== "Passed") {
    throw new Error(
      `Run Profile revision ${revision.id} is not currently passing and cannot be published.`,
    );
  }
  return revision;
}

function passingResult(state: RunProfileState, revisionId: string): ProfileResult {
  const result = latestResult(state, revisionId);
  if (result?.outcome !== "Passed") {
    throw new Error(`Run Profile revision ${revisionId} has no current passing Profile Result.`);
  }
  return result;
}

async function exactAvailableModel(
  storagePath: string,
  modelId: string,
  dependencies: RunProfileDependencies,
  expectedFiles?: RunProfileRevision["modelFiles"],
): Promise<InstalledModel> {
  const models = await (dependencies.inspectModels ?? inspectInstalledModels)(storagePath);
  const model = models.find((item) => item.id === modelId);
  if (!model?.available) {
    throw new Error(
      `Run Profile exact Installed Model is missing or unavailable: ${modelId}. No similarly named model was substituted.`,
    );
  }
  if (expectedFiles && !sameFiles(expectedFiles, model.files)) {
    throw new Error(
      `Run Profile exact Installed Model hashes changed: ${modelId}. No renamed or similarly named substitute was used.`,
    );
  }
  return model;
}

function makeRevision(input: {
  profileId: string;
  revision: number;
  name: string;
  model: InstalledModel;
  runtime: RunProfileRuntime;
  chatTemplate: string;
  controls: RunProfileControls;
  estimates: RunProfileEstimates;
  createdAt: string;
}): RunProfileRevision {
  assertRuntime(input.runtime);
  assertControls(input.controls);
  assertEstimates(input.estimates);
  const modelFiles = input.model.files.map(({ role, sha256 }) => ({ role, sha256 }));
  const chatTemplateSha256 = sha256(input.chatTemplate);
  const bound = {
    profileId: input.profileId,
    revision: input.revision,
    name: input.name,
    modelId: input.model.id,
    modelFiles,
    runtime: input.runtime,
    chatTemplateSha256,
    controls: input.controls,
  };
  const id = sha256(JSON.stringify(bound));
  return {
    id,
    ...bound,
    chatTemplate: input.chatTemplate,
    estimates: structuredClone(input.estimates),
    renderedLaunchCommand: renderLaunch(input.model, input.chatTemplate, input.controls),
    createdAt: input.createdAt,
  };
}

function renderLaunch(
  model: InstalledModel,
  chatTemplate: string,
  controls: RunProfileControls,
): string {
  const modelFile = model.files.find((file) => file.role === "model");
  if (!modelFile) throw new Error("Installed Model has no exact model GGUF file.");
  const companion = model.files.find((file) => file.role === "companion");
  const command = [
    "$CANDIDATE/runtime/llama.cpp/llama-server",
    "--model",
    modelFile.path,
    ...(companion ? ["--mmproj", companion.path] : []),
    "--host",
    "127.0.0.1",
    "--port",
    "$PROFILE_PORT",
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
    "--chat-template",
    chatTemplate,
  ];
  return command.map(shellWord).join(" ");
}

function observationMismatches(
  revision: RunProfileRevision,
  observation: ProfileTestObservation,
): string[] {
  const expected = {
    revisionId: revision.id,
    modelId: revision.modelId,
    modelFiles: revision.modelFiles,
    runtime: revision.runtime,
    chatTemplateSha256: revision.chatTemplateSha256,
    controls: revision.controls,
    contextPerSlot: revision.controls.contextSize,
    slotCount: revision.controls.parallelSlots,
    kvLayout: revision.controls.kvUnified ? "unified" : "per-slot",
  };
  const actual = {
    revisionId: observation.revisionId,
    modelId: observation.effective.modelId,
    modelFiles: observation.effective.modelFiles,
    runtime: observation.effective.runtime,
    chatTemplateSha256: observation.effective.chatTemplateSha256,
    controls: observation.effective.controls,
    contextPerSlot: observation.effective.contextPerSlot,
    slotCount: observation.effective.slotCount,
    kvLayout: observation.effective.kvLayout,
  };
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? []
    : ["Exact Profile Test observation did not match the selected revision."];
}

function sameBoundInputs(left: RunProfileRevision, right: RunProfileRevision): boolean {
  return (
    JSON.stringify({
      name: left.name,
      modelId: left.modelId,
      modelFiles: left.modelFiles,
      runtime: left.runtime,
      chatTemplateSha256: left.chatTemplateSha256,
      controls: left.controls,
      estimates: left.estimates,
    }) ===
    JSON.stringify({
      name: right.name,
      modelId: right.modelId,
      modelFiles: right.modelFiles,
      runtime: right.runtime,
      chatTemplateSha256: right.chatTemplateSha256,
      controls: right.controls,
      estimates: right.estimates,
    })
  );
}

function sameFiles(
  expected: RunProfileRevision["modelFiles"],
  actual: InstalledModel["files"],
): boolean {
  return (
    JSON.stringify(expected) ===
    JSON.stringify(actual.map(({ role, sha256 }) => ({ role, sha256 })))
  );
}

function latestRevision(state: RunProfileState, profileId: string): RunProfileRevision {
  const revisions = state.revisions.filter((item) => item.profileId === profileId);
  const latest = revisions.sort((left, right) => right.revision - left.revision)[0];
  if (!latest) throw new Error(`Unknown Run Profile: ${profileId}`);
  return latest;
}

function latestResult(state: RunProfileState, revisionId: string): ProfileResult | undefined {
  return state.results.filter((item) => item.revisionId === revisionId).at(-1);
}

function exactRevision(state: RunProfileState, revisionId: string): RunProfileRevision {
  const revision = state.revisions.find((item) => item.id === revisionId);
  if (!revision) {
    throw new Error(
      `Unknown exact Run Profile revision: ${revisionId}. No similarly named revision was substituted.`,
    );
  }
  return revision;
}

function exactSharedModel(state: RunProfileState, id: string): SharedModel {
  const shared = state.sharedModels.find((item) => item.id === id);
  if (!shared) throw new Error(`Unknown exact Shared Model: ${id}.`);
  return shared;
}

function assertRuntime(runtime: RunProfileRuntime): void {
  if (
    runtime.build !== "b10107" ||
    runtime.commit !== "c0bc8591e8815c63cb01dd3f051a8b0df02501c9" ||
    !/^[0-9a-f]{64}$/.test(runtime.binarySha256)
  ) {
    throw new Error("Run Profile must bind the exact pinned llama.cpp b10107 binary.");
  }
}

function assertControls(controls: RunProfileControls): void {
  for (const [name, value] of Object.entries(controls)) {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Run Profile load control ${name} must be an explicit non-negative integer.`);
    }
  }
  if (
    controls.contextSize < 1 ||
    controls.parallelSlots < 1 ||
    controls.batchSize < 1 ||
    controls.microBatchSize < 1 ||
    controls.threads < 1 ||
    controls.threadsBatch < 1 ||
    controls.microBatchSize > controls.batchSize
  ) {
    throw new Error("Run Profile load controls are incomplete or incompatible.");
  }
  if (!controls.cacheTypeK || !controls.cacheTypeV) {
    throw new Error("Run Profile KV cache types must be explicit.");
  }
}

function assertEstimates(estimates: RunProfileEstimates): void {
  for (const value of [estimates.projectedRamBytes, estimates.projectedGpuBytes]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Run Profile estimates must be non-negative byte counts or null.");
    }
  }
}

function assertLimits(limits: SharedModelLimits, contextPerSlot: number): void {
  if (
    !Number.isSafeInteger(limits.contextTokens) ||
    limits.contextTokens < 1 ||
    limits.contextTokens > contextPerSlot ||
    !Number.isSafeInteger(limits.outputTokens) ||
    limits.outputTokens < 1 ||
    limits.outputTokens > limits.contextTokens ||
    !Number.isSafeInteger(limits.concurrentRequests) ||
    limits.concurrentRequests < 1
  ) {
    throw new Error("Shared Model Member limits exceed the exact passing Profile Result.");
  }
}

function assertExposedCapabilities(
  capabilities: SharedModel["capabilities"],
  result: ProfileResult,
): void {
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
    throw new Error("Shared Model must expose a unique non-empty capability subset.");
  }
  for (const capability of capabilities) {
    if (result.capabilities[capability] !== "Passed") {
      throw new Error(`Shared Model capability ${capability} has no exact passing behavior proof.`);
    }
  }
}

function validMeasurements(observation: ProfileTestObservation): boolean {
  return [
    observation.performance.loadTimeMs,
    observation.performance.firstTokenTimeMs,
    observation.performance.throughputTokensPerSecond,
    observation.resources.peakRamBytes,
    observation.resources.peakGpuBytes,
  ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:$=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

function allocateId(proposed: string, used: Set<string>): string {
  if (!used.has(proposed)) return proposed;
  let suffix = 2;
  while (used.has(`${proposed}-${suffix}`)) suffix += 1;
  return `${proposed}-${suffix}`;
}

function now(dependencies: RunProfileDependencies): string {
  return (dependencies.now ?? (() => new Date()))().toISOString();
}

async function mutateState<T>(
  storagePath: string,
  mutation: (state: RunProfileState) => Promise<T>,
): Promise<T> {
  const lockPath = join(storagePath, ".localhub-catalog", "run-profile.lock");
  const deadline = Date.now() + 300_000;
  await mkdir(join(storagePath, ".localhub-catalog"), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await Bun.sleep(25);
    }
  }
  try {
    const state = await readState(storagePath);
    const result = await mutation(state);
    await writeState(storagePath, state);
    return result;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readState(storagePath: string): Promise<RunProfileState> {
  const path = join(storagePath, ".localhub-catalog", "run-profiles.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: RUN_PROFILE_STATE_SCHEMA, revisions: [], results: [], sharedModels: [] };
    }
    throw new Error(`Run Profile catalog is unreadable: ${errorMessage(error)}`);
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== RUN_PROFILE_STATE_SCHEMA ||
    !Array.isArray(parsed.revisions) ||
    !Array.isArray(parsed.results) ||
    !Array.isArray(parsed.sharedModels)
  ) {
    throw new Error("Run Profile catalog is malformed; no replacement catalog was used.");
  }
  return parsed as unknown as RunProfileState;
}

async function writeState(storagePath: string, state: RunProfileState): Promise<void> {
  const path = join(storagePath, ".localhub-catalog", "run-profiles.json");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
