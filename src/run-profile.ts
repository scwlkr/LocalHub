import { createHash, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertManagedModelStorage,
  type InstalledModel,
  inspectInstalledModels,
  inspectInstalledModelsUnderCatalogLock,
  type ModelMutationDependencies,
  withModelCatalogMutationLock,
} from "./model-acquisition.ts";

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

type StoredRunProfileRevision = Omit<RunProfileRevision, "renderedLaunchCommand">;

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

export interface ProfileHostBinding {
  hardware: string;
  devices: string[];
  osVersion: string;
}

export type CurrentProfileBinding =
  | { available: true; runtime: RunProfileRuntime; host: ProfileHostBinding }
  | { available: false; cause: string };

export interface SharedModelLimits {
  contextTokens: number;
  outputTokens: number;
  concurrentRequests: number;
}

export interface SharedModel {
  id: string;
  name: string;
  revisionId: string;
  profileResultId: string;
  limits: SharedModelLimits;
  capabilities: Array<"text" | OptionalCapability>;
  pinned: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InspectedSharedModel extends SharedModel {
  evidenceState: EvidenceState;
  acceptingNewWork: boolean;
  unavailableCause: string | null;
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
  revisions: StoredRunProfileRevision[];
  results: ProfileResult[];
  sharedModels: SharedModel[];
}

export interface RunProfileDependencies extends ModelMutationDependencies {
  inspectModels?: (storagePath: string) => Promise<InstalledModel[]>;
  currentBinding?: CurrentProfileBinding;
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
  return await mutateState(
    storagePath,
    async (state) => {
      const model = await exactAvailableModel(
        storagePath,
        input.modelId,
        dependencies,
        undefined,
        true,
      );
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
      return revisionWithCommand(revision, model);
    },
    dependencies,
  );
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
  return await mutateState(
    storagePath,
    async (state) => {
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
        undefined,
        true,
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
      return revisionWithCommand(candidate, model);
    },
    dependencies,
  );
}

export async function testRunProfile(
  storagePath: string,
  revisionId: string,
  observation: ProfileTestObservation,
  dependencies: RunProfileDependencies = {},
): Promise<ProfileResult> {
  return await mutateState(
    storagePath,
    async (state) => {
      const revision = exactRevision(state, revisionId);
      await exactAvailableModel(
        storagePath,
        revision.modelId,
        dependencies,
        revision.modelFiles,
        true,
      );
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
    },
    dependencies,
  );
}

export async function inspectRunProfiles(
  storagePath: string,
  dependencies: RunProfileDependencies = {},
): Promise<{
  revisions: Array<RunProfileRevision & { evidenceState: EvidenceState }>;
  results: Array<ProfileResult & { evidenceState: EvidenceState }>;
  sharedModels: InspectedSharedModel[];
}> {
  await assertManagedModelStorage(resolve(storagePath));
  const currentBinding = requiredCurrentBinding(dependencies);
  const state = await readState(storagePath);
  const models = await (dependencies.inspectModels ?? inspectInstalledModels)(storagePath);
  const revisions = state.revisions.map((revision) => ({
    ...revisionWithCurrentCommand(revision, models),
    evidenceState: evidenceState(state, revision, models, currentBinding),
  }));
  const results = state.results.map((result) => ({
    ...result,
    evidenceState: evidenceState(
      state,
      exactRevision(state, result.revisionId),
      models,
      currentBinding,
      result,
    ),
  }));
  const sharedModels = state.sharedModels.map((shared) => {
    const revision = exactRevision(state, shared.revisionId);
    const currentEvidence = evidenceState(state, revision, models, currentBinding);
    const acceptingNewWork = shared.published && currentEvidence === "Passed";
    return {
      ...shared,
      evidenceState: currentEvidence,
      acceptingNewWork,
      unavailableCause: acceptingNewWork
        ? null
        : sharedUnavailability(shared, currentEvidence, currentBinding),
    };
  });
  return { revisions, results, sharedModels };
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
  return await mutateState(
    storagePath,
    async (state) => {
      const revision = await currentlyPassingRevision(
        storagePath,
        state,
        input.revisionId,
        dependencies,
        true,
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
      assertLimits(input.limits, result.effective.contextPerSlot, result.effective.slotCount);
      assertExposedCapabilities(input.capabilities, result);
      const timestamp = now(dependencies);
      const shared: SharedModel = {
        id: allocateId(
          (dependencies.randomId ?? randomUUID)(),
          new Set(state.sharedModels.map((item) => item.id)),
        ),
        name,
        revisionId: revision.id,
        profileResultId: result.id,
        limits: structuredClone(input.limits),
        capabilities: [...input.capabilities],
        pinned: false,
        published: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.sharedModels.push(shared);
      return shared;
    },
    dependencies,
  );
}

export async function setSharedModelPin(
  storagePath: string,
  sharedModelId: string,
  pinned: boolean,
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(
    storagePath,
    async (state) => {
      const shared = exactSharedModel(state, sharedModelId);
      if (pinned) {
        await currentlyPassingRevision(storagePath, state, shared.revisionId, dependencies, true);
      }
      shared.pinned = pinned;
      shared.updatedAt = now(dependencies);
      return structuredClone(shared);
    },
    dependencies,
  );
}

export async function setSharedModelPublished(
  storagePath: string,
  sharedModelId: string,
  published: boolean,
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(
    storagePath,
    async (state) => {
      const shared = exactSharedModel(state, sharedModelId);
      if (published) {
        const revision = await currentlyPassingRevision(
          storagePath,
          state,
          shared.revisionId,
          dependencies,
          true,
        );
        shared.profileResultId = passingResult(state, revision.id).id;
      }
      shared.published = published;
      shared.updatedAt = now(dependencies);
      return structuredClone(shared);
    },
    dependencies,
  );
}

export async function replaceSharedModel(
  storagePath: string,
  sharedModelId: string,
  revisionId: string,
  dependencies: RunProfileDependencies = {},
): Promise<SharedModel> {
  return await mutateState(
    storagePath,
    async (state) => {
      const shared = exactSharedModel(state, sharedModelId);
      const revision = await currentlyPassingRevision(
        storagePath,
        state,
        revisionId,
        dependencies,
        true,
      );
      const result = passingResult(state, revision.id);
      assertLimits(shared.limits, result.effective.contextPerSlot, result.effective.slotCount);
      assertExposedCapabilities(shared.capabilities, result);
      shared.revisionId = revision.id;
      shared.profileResultId = result.id;
      shared.updatedAt = now(dependencies);
      return structuredClone(shared);
    },
    dependencies,
  );
}

export async function acceptSharedModelRequest(
  storagePath: string,
  sharedModelId: string,
  dependencies: RunProfileDependencies = {},
): Promise<AcceptedSharedModelTarget> {
  await assertManagedModelStorage(resolve(storagePath));
  const state = await readState(storagePath);
  const shared = exactSharedModel(state, sharedModelId);
  assertSharedModelAuthority(state, shared);
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

export type EvidenceState = "Untested" | "Passed" | "Failed" | "Stale" | "Missing";

function evidenceState(
  state: RunProfileState,
  revision: StoredRunProfileRevision,
  models: InstalledModel[],
  currentBinding: CurrentProfileBinding,
  selectedResult?: ProfileResult,
): EvidenceState {
  const model = models.find((item) => item.id === revision.modelId);
  if (!model?.available || !sameFiles(revision.modelFiles, model.files)) return "Missing";
  if (latestRevision(state, revision.profileId).id !== revision.id) return "Stale";
  if (!currentBinding.available) return "Missing";
  if (!sameRuntime(revision.runtime, currentBinding.runtime)) return "Stale";
  const result = selectedResult ?? latestResult(state, revision.id);
  if (!result) return "Untested";
  if (!sameHostBinding(result.host, currentBinding.host)) return "Stale";
  return result.outcome;
}

async function currentlyPassingRevision(
  storagePath: string,
  state: RunProfileState,
  revisionId: string,
  dependencies: RunProfileDependencies,
  catalogLockHeld = false,
): Promise<StoredRunProfileRevision> {
  const revision = exactRevision(state, revisionId);
  if (latestRevision(state, revision.profileId).id !== revision.id) {
    throw new Error(`Run Profile revision ${revision.id} is stale and cannot accept new work.`);
  }
  const currentBinding = requiredCurrentBinding(dependencies);
  if (!currentBinding.available) {
    throw new Error(
      `Run Profile revision ${revision.id} exact current runtime is unavailable: ${currentBinding.cause}`,
    );
  }
  if (!sameRuntime(revision.runtime, currentBinding.runtime)) {
    throw new Error(
      `Run Profile revision ${revision.id} requires a different exact runtime and is stale in this candidate.`,
    );
  }
  await exactAvailableModel(
    storagePath,
    revision.modelId,
    dependencies,
    revision.modelFiles,
    catalogLockHeld,
  );
  const result = latestResult(state, revision.id);
  if (result?.outcome !== "Passed") {
    throw new Error(
      `Run Profile revision ${revision.id} is not currently passing and cannot be published.`,
    );
  }
  if (!sameHostBinding(result.host, currentBinding.host)) {
    throw new Error(
      `Run Profile revision ${revision.id} Host hardware, device inventory, or operating system changed and its result is stale.`,
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

function assertSharedModelAuthority(state: RunProfileState, shared: SharedModel): ProfileResult {
  const result = state.results.find((item) => item.id === shared.profileResultId);
  if (result?.outcome !== "Passed" || result.revisionId !== shared.revisionId) {
    throw new Error(`Shared Model ${shared.id} is not bound to its exact passing Profile Result.`);
  }
  assertLimits(shared.limits, result.effective.contextPerSlot, result.effective.slotCount);
  assertExposedCapabilities(shared.capabilities, result);
  return result;
}

async function exactAvailableModel(
  storagePath: string,
  modelId: string,
  dependencies: RunProfileDependencies,
  expectedFiles?: RunProfileRevision["modelFiles"],
  catalogLockHeld = false,
): Promise<InstalledModel> {
  const inspectModels =
    dependencies.inspectModels ??
    (catalogLockHeld ? inspectInstalledModelsUnderCatalogLock : inspectInstalledModels);
  const models = await inspectModels(storagePath);
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
}): StoredRunProfileRevision {
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
    createdAt: input.createdAt,
  };
}

function revisionWithCommand(
  revision: StoredRunProfileRevision,
  model: InstalledModel,
): RunProfileRevision {
  return {
    ...revision,
    renderedLaunchCommand: renderLaunch(
      revision.id,
      model,
      revision.chatTemplate,
      revision.controls,
    ),
  };
}

function revisionWithCurrentCommand(
  revision: StoredRunProfileRevision,
  models: InstalledModel[],
): RunProfileRevision {
  const model = models.find(
    (item) =>
      item.id === revision.modelId && item.available && sameFiles(revision.modelFiles, item.files),
  );
  if (!model) {
    return {
      ...revision,
      renderedLaunchCommand: `Unavailable: exact Installed Model ${revision.modelId} is not verified.`,
    };
  }
  return revisionWithCommand(revision, model);
}

function renderLaunch(
  revisionId: string,
  model: InstalledModel,
  chatTemplate: string,
  controls: RunProfileControls,
): string {
  return profileLaunchCommand({
    binaryPath: "$CANDIDATE/runtime/llama.cpp/llama-server",
    revisionId,
    model,
    port: "$PROFILE_PORT",
    controls,
    chatTemplate,
  })
    .map(shellWord)
    .join(" ");
}

export function profileLaunchCommand(input: {
  binaryPath: string;
  revisionId: string;
  model: InstalledModel;
  port: string;
  controls: RunProfileControls;
  chatTemplate: string;
}): string[] {
  const { binaryPath, revisionId, model, port, controls, chatTemplate } = input;
  const modelFile = model.files.find((file) => file.role === "model");
  if (!modelFile) throw new Error("Installed Model has no exact model GGUF file.");
  const companion = model.files.find((file) => file.role === "companion");
  return [
    binaryPath,
    "--model",
    modelFile.path,
    ...(companion ? ["--mmproj", companion.path] : []),
    "--alias",
    revisionId,
    "--host",
    "127.0.0.1",
    "--port",
    port,
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
    "--log-verbosity",
    "5",
    "--log-colors",
    "off",
    "--no-log-timestamps",
    "--no-webui",
    "--no-agent",
    "--no-ui-mcp-proxy",
    "--cors-origins",
    "localhost",
    "--offline",
    "--chat-template",
    chatTemplate,
  ];
}

function observationMismatches(
  revision: StoredRunProfileRevision,
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

function sameBoundInputs(left: StoredRunProfileRevision, right: StoredRunProfileRevision): boolean {
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

function sameRuntime(left: RunProfileRuntime, right: RunProfileRuntime): boolean {
  return (
    left.build === right.build &&
    left.commit === right.commit &&
    left.binarySha256 === right.binarySha256
  );
}

function sameHostBinding(left: ProfileHostBinding, right: ProfileHostBinding): boolean {
  return (
    left.hardware === right.hardware &&
    left.osVersion === right.osVersion &&
    JSON.stringify(left.devices) === JSON.stringify(right.devices)
  );
}

function requiredCurrentBinding(dependencies: RunProfileDependencies): CurrentProfileBinding {
  if (!dependencies.currentBinding) {
    throw new Error(
      "Current Run Profile runtime and Host binding is required to determine availability.",
    );
  }
  return dependencies.currentBinding;
}

function sharedUnavailability(
  shared: SharedModel,
  evidenceState: EvidenceState,
  currentBinding: CurrentProfileBinding,
): string {
  if (!shared.published) return "Shared Model is explicitly unshared.";
  if (!currentBinding.available) return currentBinding.cause;
  return `Exact Run Profile evidence is ${evidenceState}.`;
}

function latestRevision(state: RunProfileState, profileId: string): StoredRunProfileRevision {
  const revisions = state.revisions.filter((item) => item.profileId === profileId);
  const latest = revisions.sort((left, right) => right.revision - left.revision)[0];
  if (!latest) throw new Error(`Unknown Run Profile: ${profileId}`);
  return latest;
}

function latestResult(state: RunProfileState, revisionId: string): ProfileResult | undefined {
  return state.results.filter((item) => item.revisionId === revisionId).at(-1);
}

function exactRevision(state: RunProfileState, revisionId: string): StoredRunProfileRevision {
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

function assertLimits(limits: SharedModelLimits, contextPerSlot: number, slotCount: number): void {
  if (
    !Number.isSafeInteger(limits.contextTokens) ||
    limits.contextTokens < 1 ||
    limits.contextTokens > contextPerSlot ||
    !Number.isSafeInteger(limits.outputTokens) ||
    limits.outputTokens < 1 ||
    limits.outputTokens > limits.contextTokens ||
    !Number.isSafeInteger(limits.concurrentRequests) ||
    limits.concurrentRequests < 1 ||
    limits.concurrentRequests > slotCount
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
  dependencies: RunProfileDependencies = {},
): Promise<T> {
  const exactStoragePath = resolve(storagePath);
  return await withModelCatalogMutationLock(exactStoragePath, dependencies, async () => {
    const state = await readState(storagePath);
    const result = await mutation(state);
    await writeState(storagePath, state);
    return result;
  });
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
  if (!validRunProfileState(parsed)) {
    throw new Error(
      "Run Profile catalog is incomplete or malformed; no replacement catalog was used.",
    );
  }
  return parsed;
}

function validRunProfileState(value: unknown): value is RunProfileState {
  if (
    !isRecord(value) ||
    value.schema !== RUN_PROFILE_STATE_SCHEMA ||
    !Array.isArray(value.revisions) ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.sharedModels)
  ) {
    return false;
  }
  if (
    !value.revisions.every(validRevision) ||
    !value.results.every(validResult) ||
    !value.sharedModels.every(validSharedModel)
  ) {
    return false;
  }

  const revisions = value.revisions as StoredRunProfileRevision[];
  const results = value.results as ProfileResult[];
  const sharedModels = value.sharedModels as SharedModel[];
  const revisionIds = new Set(revisions.map((item) => item.id));
  if (revisionIds.size !== revisions.length) return false;
  if (new Set(results.map((item) => item.id)).size !== results.length) return false;
  if (new Set(sharedModels.map((item) => item.id)).size !== sharedModels.length) return false;
  if (results.some((item) => !revisionIds.has(item.revisionId))) return false;
  if (sharedModels.some((item) => !revisionIds.has(item.revisionId))) return false;
  const foldedSharedNames = sharedModels.map((item) => item.name.toLocaleLowerCase("en-US"));
  if (new Set(foldedSharedNames).size !== foldedSharedNames.length) return false;

  const profileRevisions = new Set<string>();
  const revisionsByProfile = new Map<string, number[]>();
  for (const revision of revisions) {
    const key = `${revision.profileId}\0${revision.revision}`;
    if (profileRevisions.has(key)) return false;
    profileRevisions.add(key);
    const bound = {
      profileId: revision.profileId,
      revision: revision.revision,
      name: revision.name,
      modelId: revision.modelId,
      modelFiles: revision.modelFiles,
      runtime: revision.runtime,
      chatTemplateSha256: revision.chatTemplateSha256,
      controls: revision.controls,
    };
    if (revision.id !== sha256(JSON.stringify(bound))) return false;
    const sequence = revisionsByProfile.get(revision.profileId) ?? [];
    sequence.push(revision.revision);
    revisionsByProfile.set(revision.profileId, sequence);
  }
  for (const sequence of revisionsByProfile.values()) {
    sequence.sort((left, right) => left - right);
    if (sequence.some((revision, index) => revision !== index + 1)) return false;
  }
  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]));
  for (const result of results) {
    const revision = revisionsById.get(result.revisionId);
    if (!revision) return false;
    if (result.outcome === "Passed" && !validPassingResultForRevision(result, revision)) {
      return false;
    }
  }
  try {
    for (const shared of sharedModels) {
      assertSharedModelAuthority(value as unknown as RunProfileState, shared);
    }
  } catch {
    return false;
  }
  return true;
}

function validPassingResultForRevision(
  result: ProfileResult,
  revision: StoredRunProfileRevision,
): boolean {
  return (
    result.failure === null &&
    result.capabilities.text === "Passed" &&
    result.load.passed &&
    result.health.passed &&
    result.textResponse.passed &&
    result.textResponse.outputTokens > 0 &&
    result.cancellation.passed &&
    result.cancellation.slotReleasedMs <= 10_000 &&
    result.stop.passed &&
    result.stop.graceful &&
    result.host.devices.length > 0 &&
    !result.effective.automaticFit &&
    !result.effective.builtInTools &&
    !result.effective.builtInAgent &&
    result.effective.modelId === revision.modelId &&
    JSON.stringify(result.effective.modelFiles) === JSON.stringify(revision.modelFiles) &&
    sameRuntime(result.effective.runtime, revision.runtime) &&
    result.effective.chatTemplateSha256 === revision.chatTemplateSha256 &&
    JSON.stringify(result.effective.controls) === JSON.stringify(revision.controls) &&
    result.effective.contextPerSlot === revision.controls.contextSize &&
    result.effective.slotCount === revision.controls.parallelSlots &&
    result.effective.kvLayout === (revision.controls.kvUnified ? "unified" : "per-slot")
  );
}

function validRevision(value: unknown): value is StoredRunProfileRevision {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "id",
      "profileId",
      "revision",
      "name",
      "modelId",
      "modelFiles",
      "runtime",
      "chatTemplate",
      "chatTemplateSha256",
      "controls",
      "estimates",
      "createdAt",
    ]) &&
    sha256String(value.id) &&
    safeId(value.profileId) &&
    positiveInteger(value.revision) &&
    nonBlankString(value.name) &&
    sha256String(value.modelId) &&
    validModelFiles(value.modelFiles) &&
    validRuntime(value.runtime) &&
    nonBlankString(value.chatTemplate) &&
    sha256String(value.chatTemplateSha256) &&
    value.chatTemplateSha256 === sha256(value.chatTemplate) &&
    validControls(value.controls) &&
    validEstimates(value.estimates) &&
    validTimestamp(value.createdAt)
  );
}

function validResult(value: unknown): value is ProfileResult {
  if (!isRecord(value)) return false;
  if (
    !safeId(value.id) ||
    !sha256String(value.revisionId) ||
    (value.outcome !== "Passed" && value.outcome !== "Failed") ||
    !validEffective(value.effective) ||
    !validCapabilities(value.capabilities) ||
    !validMeasurementsRecord(value.measurements) ||
    !validPassedRecord(value.load) ||
    !validPassedRecord(value.health) ||
    !validTextResponse(value.textResponse) ||
    !validCancellation(value.cancellation) ||
    !validStop(value.stop) ||
    !validHost(value.host) ||
    !(value.failure === null || typeof value.failure === "string") ||
    !validTimestamp(value.testedAt)
  ) {
    return false;
  }
  return value.outcome === "Passed" ? value.failure === null : nonBlankString(value.failure);
}

function validSharedModel(value: unknown): value is SharedModel {
  if (!isRecord(value)) return false;
  return (
    safeId(value.id) &&
    nonBlankString(value.name) &&
    sha256String(value.revisionId) &&
    safeId(value.profileResultId) &&
    validLimits(value.limits) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    new Set(value.capabilities).size === value.capabilities.length &&
    value.capabilities.every((item) =>
      ["text", "imageInput", "browserTools", "toolRunnerFunctions"].includes(String(item)),
    ) &&
    typeof value.pinned === "boolean" &&
    typeof value.published === "boolean" &&
    validTimestamp(value.createdAt) &&
    validTimestamp(value.updatedAt)
  );
}

function validEffective(value: unknown): value is ProfileTestObservation["effective"] {
  if (!isRecord(value)) return false;
  return (
    sha256String(value.modelId) &&
    validModelFiles(value.modelFiles) &&
    validRuntime(value.runtime) &&
    sha256String(value.chatTemplateSha256) &&
    validControls(value.controls) &&
    positiveInteger(value.contextPerSlot) &&
    positiveInteger(value.slotCount) &&
    (value.kvLayout === "unified" || value.kvLayout === "per-slot") &&
    nonBlankString(value.placement) &&
    typeof value.builtInTools === "boolean" &&
    typeof value.builtInAgent === "boolean" &&
    typeof value.automaticFit === "boolean"
  );
}

function validRuntime(value: unknown): value is RunProfileRuntime {
  if (!isRecord(value)) return false;
  try {
    assertRuntime(value as unknown as RunProfileRuntime);
    return true;
  } catch {
    return false;
  }
}

function validControls(value: unknown): value is RunProfileControls {
  if (!isRecord(value)) return false;
  const booleans = [value.kvUnified, value.kvOffload, value.continuousBatching, value.warmup];
  const integers = [
    value.contextSize,
    value.parallelSlots,
    value.batchSize,
    value.microBatchSize,
    value.gpuLayers,
    value.threads,
    value.threadsBatch,
    value.mainGpu,
  ];
  if (
    booleans.some((item) => typeof item !== "boolean") ||
    integers.some((item) => !Number.isSafeInteger(item) || Number(item) < 0) ||
    !["on", "off"].includes(String(value.flashAttention)) ||
    !["mmap", "read", "mlock"].includes(String(value.loadMode)) ||
    !["none", "layer", "row", "tensor"].includes(String(value.splitMode)) ||
    !nonBlankString(value.cacheTypeK) ||
    !nonBlankString(value.cacheTypeV)
  ) {
    return false;
  }
  try {
    assertControls(value as unknown as RunProfileControls);
    return true;
  } catch {
    return false;
  }
}

function validEstimates(value: unknown): value is RunProfileEstimates {
  if (!isRecord(value)) return false;
  try {
    assertEstimates(value as unknown as RunProfileEstimates);
    return "projectedRamBytes" in value && "projectedGpuBytes" in value;
  } catch {
    return false;
  }
}

function validModelFiles(value: unknown): value is RunProfileRevision["modelFiles"] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let modelCount = 0;
  let companionCount = 0;
  for (const item of value) {
    if (!isRecord(item) || !sha256String(item.sha256)) return false;
    if (item.role === "model") modelCount += 1;
    else if (item.role === "companion") companionCount += 1;
    else return false;
  }
  return (
    modelCount >= 1 &&
    companionCount <= 1 &&
    new Set(value.map((item) => `${String(item.role)}:${String(item.sha256)}`)).size ===
      value.length
  );
}

function validCapabilities(value: unknown): value is ProfileResult["capabilities"] {
  if (!isRecord(value)) return false;
  return ["text", "imageInput", "browserTools", "toolRunnerFunctions"].every((key) =>
    ["Passed", "Failed", "Unavailable"].includes(String(value[key])),
  );
}

function validMeasurementsRecord(value: unknown): value is ProfileResult["measurements"] {
  if (!isRecord(value)) return false;
  return [
    value.loadTimeMs,
    value.firstTokenTimeMs,
    value.throughputTokensPerSecond,
    value.peakRamBytes,
    value.peakGpuBytes,
  ].every(nonNegativeNumber);
}

function validPassedRecord(value: unknown): value is { passed: boolean } {
  return isRecord(value) && typeof value.passed === "boolean";
}

function validTextResponse(value: unknown): value is ProfileTestObservation["textResponse"] {
  return (
    validPassedRecord(value) && nonNegativeInteger((value as Record<string, unknown>).outputTokens)
  );
}

function validCancellation(value: unknown): value is ProfileTestObservation["cancellation"] {
  return (
    validPassedRecord(value) && nonNegativeNumber((value as Record<string, unknown>).slotReleasedMs)
  );
}

function validStop(value: unknown): value is ProfileTestObservation["stop"] {
  return (
    validPassedRecord(value) && typeof (value as Record<string, unknown>).graceful === "boolean"
  );
}

function validHost(value: unknown): value is ProfileHostBinding {
  return (
    isRecord(value) &&
    nonBlankString(value.hardware) &&
    Array.isArray(value.devices) &&
    value.devices.every(nonBlankString) &&
    nonBlankString(value.osVersion)
  );
}

function validLimits(value: unknown): value is SharedModelLimits {
  return (
    isRecord(value) &&
    positiveInteger(value.contextTokens) &&
    positiveInteger(value.outputTokens) &&
    value.outputTokens <= value.contextTokens &&
    positiveInteger(value.concurrentRequests)
  );
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
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
