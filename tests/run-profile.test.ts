import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledModel } from "../src/model-acquisition.ts";
import {
  acceptSharedModelRequest,
  createRunProfile,
  inspectRunProfiles,
  publishSharedModel,
  replaceSharedModel,
  reviseRunProfile,
  setSharedModelPin,
  setSharedModelPublished,
  testRunProfile,
  type ProfileTestObservation,
  type RunProfileControls,
  type RunProfileRuntime,
} from "../src/run-profile.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("editing an exact passing Run Profile creates an untested revision and derives stale evidence", async () => {
  const storagePath = await modelStorage();
  const model = installedModel();
  const runtime = pinnedRuntime();
  const first = await createRunProfile(
    storagePath,
    {
      name: "House text",
      modelId: model.id,
      runtime,
      chatTemplate: "{{ messages }}",
      controls: controls(),
      estimates: { projectedRamBytes: 700_000_000, projectedGpuBytes: 500_000_000 },
    },
    catalogDependencies(model),
  );

  expect(first.revision).toBe(1);
  expect(first.modelFiles).toEqual([
    { role: "model", sha256: "a".repeat(64) },
    { role: "companion", sha256: "b".repeat(64) },
  ]);
  expect(first.renderedLaunchCommand).toContain("--fit off");
  expect(first.renderedLaunchCommand).toContain("--ctx-size 4096");
  expect(first.renderedLaunchCommand).toContain("--parallel 2");
  expect(first.renderedLaunchCommand).toContain(`--alias ${first.id}`);
  expect(first.renderedLaunchCommand).toContain("--no-agent");
  expect(first.renderedLaunchCommand).toContain("--no-ui-mcp-proxy");
  expect(first.renderedLaunchCommand).toContain("--offline");

  const result = await testRunProfile(
    storagePath,
    first.id,
    passingObservation(first.id, model, runtime),
    catalogDependencies(model),
  );
  expect(result.outcome).toBe("Passed");
  expect(result.capabilities).toEqual({
    text: "Passed",
    imageInput: "Unavailable",
    browserTools: "Unavailable",
    toolRunnerFunctions: "Unavailable",
  });

  const second = await reviseRunProfile(
    storagePath,
    first.id,
    { controls: { ...first.controls, contextSize: 8192 } },
    catalogDependencies(model),
  );
  expect(second).toMatchObject({ profileId: first.profileId, revision: 2 });
  expect(second.id).not.toBe(first.id);

  const ledger = await inspectRunProfiles(storagePath, catalogDependencies(model));
  expect(ledger.revisions).toMatchObject([
    { id: first.id, evidenceState: "Stale" },
    { id: second.id, evidenceState: "Untested" },
  ]);
  expect(ledger.results).toMatchObject([
    {
      revisionId: first.id,
      outcome: "Passed",
      evidenceState: "Stale",
      measurements: {
        loadTimeMs: 1200,
        firstTokenTimeMs: 90,
        throughputTokensPerSecond: 14.5,
        peakRamBytes: 620_000_000,
        peakGpuBytes: 410_000_000,
      },
    },
  ]);
  expect(ledger.revisions[0]?.estimates).toEqual({
    projectedRamBytes: 700_000_000,
    projectedGpuBytes: 500_000_000,
  });
});

test("Profile Test fails closed when any exact observation or mandatory behavior differs", async () => {
  const storagePath = await modelStorage();
  const model = installedModel();
  const runtime = pinnedRuntime();
  const revision = await createRunProfile(
    storagePath,
    {
      name: "Exact only",
      modelId: model.id,
      runtime,
      chatTemplate: "{{ messages }}",
      controls: controls(),
      estimates: { projectedRamBytes: null, projectedGpuBytes: null },
    },
    catalogDependencies(model),
  );

  const failed = await testRunProfile(
    storagePath,
    revision.id,
    {
      ...passingObservation(revision.id, model, runtime),
      effective: {
        ...passingObservation(revision.id, model, runtime).effective,
        modelFiles: [{ role: "model", sha256: "c".repeat(64) }],
      },
      textResponse: { passed: false, outputTokens: 0 },
      failure: "Exact loaded model identity did not match; no similarly named model was used.",
    },
    catalogDependencies(model),
  );

  expect(failed).toMatchObject({
    outcome: "Failed",
    failure: expect.stringContaining("did not match"),
  });
  await expect(
    publishSharedModel(
      storagePath,
      {
        name: "Members",
        revisionId: revision.id,
        limits: { contextTokens: 2048, outputTokens: 256, concurrentRequests: 1 },
        capabilities: ["text"],
      },
      catalogDependencies(model),
    ),
  ).rejects.toThrow("currently passing");
});

test("publish, pin, unshare, share, and replacement are explicit while accepted work stays exact", async () => {
  const storagePath = await modelStorage();
  const model = installedModel();
  const runtime = pinnedRuntime();
  const first = await passingRevision(storagePath, "Members v1", model, runtime, 4096);
  await expect(
    publishSharedModel(
      storagePath,
      {
        name: "Too much concurrency",
        revisionId: first.id,
        limits: { contextTokens: 2048, outputTokens: 256, concurrentRequests: 3 },
        capabilities: ["text"],
      },
      catalogDependencies(model),
    ),
  ).rejects.toThrow("exceed");
  const shared = await publishSharedModel(
    storagePath,
    {
      name: "Family Text",
      revisionId: first.id,
      limits: { contextTokens: 2048, outputTokens: 256, concurrentRequests: 1 },
      capabilities: ["text"],
    },
    catalogDependencies(model),
  );
  const acceptedBeforeReplacement = await acceptSharedModelRequest(
    storagePath,
    shared.id,
    catalogDependencies(model),
  );

  expect(
    (await setSharedModelPin(storagePath, shared.id, true, catalogDependencies(model))).pinned,
  ).toBeTrue();
  expect((await setSharedModelPin(storagePath, shared.id, false)).pinned).toBeFalse();
  expect((await setSharedModelPublished(storagePath, shared.id, false)).published).toBeFalse();
  await expect(
    acceptSharedModelRequest(storagePath, shared.id, catalogDependencies(model)),
  ).rejects.toThrow("unshared");
  expect(
    (await setSharedModelPublished(storagePath, shared.id, true, catalogDependencies(model)))
      .published,
  ).toBeTrue();

  const second = await passingRevision(storagePath, "Members v2", model, runtime, 8192);
  const replaced = await replaceSharedModel(
    storagePath,
    shared.id,
    second.id,
    catalogDependencies(model),
  );
  const acceptedAfterReplacement = await acceptSharedModelRequest(
    storagePath,
    shared.id,
    catalogDependencies(model),
  );

  expect(replaced.revisionId).toBe(second.id);
  expect(acceptedBeforeReplacement).toMatchObject({
    sharedModelId: shared.id,
    revisionId: first.id,
    modelId: model.id,
  });
  expect(acceptedAfterReplacement.revisionId).toBe(second.id);
  expect(acceptedBeforeReplacement.revisionId).toBe(first.id);
});

test("missing, renamed, stale, incompatible, and similarly named substitutes remain unavailable", async () => {
  const storagePath = await modelStorage();
  const exact = installedModel();
  const similarlyNamed = installedModel({
    id: "d".repeat(64),
    displayName: exact.displayName,
    files: [
      {
        fileName: "similar.gguf",
        role: "model",
        path: "/models/similar.gguf",
        size: 400_000_000,
        sha256: "d".repeat(64),
        managed: true,
        shard: null,
      },
    ],
  });
  const runtime = pinnedRuntime();
  const revision = await passingRevision(storagePath, "No substitutes", exact, runtime, 4096);
  const shared = await publishSharedModel(
    storagePath,
    {
      name: "Exact Family",
      revisionId: revision.id,
      limits: { contextTokens: 2048, outputTokens: 256, concurrentRequests: 1 },
      capabilities: ["text"],
    },
    catalogDependencies(exact),
  );

  const renamedExact = { ...exact, displayName: "Renamed exact model" };
  expect(
    (
      await acceptSharedModelRequest(
        storagePath,
        shared.id,
        catalogDependencies(renamedExact, similarlyNamed),
      )
    ).modelId,
  ).toBe(exact.id);

  await expect(
    acceptSharedModelRequest(
      storagePath,
      shared.id,
      catalogDependencies({ ...exact, available: false }, similarlyNamed),
    ),
  ).rejects.toThrow("exact Installed Model is missing");

  const edited = await reviseRunProfile(
    storagePath,
    revision.id,
    { chatTemplate: "different exact template" },
    catalogDependencies(exact, similarlyNamed),
  );
  await expect(
    setSharedModelPin(storagePath, shared.id, true, catalogDependencies(exact, similarlyNamed)),
  ).rejects.toThrow("stale");
  await expect(
    publishSharedModel(
      storagePath,
      {
        name: "Stale attempt",
        revisionId: revision.id,
        limits: { contextTokens: 1024, outputTokens: 128, concurrentRequests: 1 },
        capabilities: ["text"],
      },
      catalogDependencies(exact, similarlyNamed),
    ),
  ).rejects.toThrow("stale");
  await expect(
    replaceSharedModel(
      storagePath,
      shared.id,
      edited.id,
      catalogDependencies(exact, similarlyNamed),
    ),
  ).rejects.toThrow("currently passing");

  const differentRuntime = {
    ...runtime,
    binarySha256: "9".repeat(64),
  } as RunProfileRuntime;
  const runtimeLedger = await inspectRunProfiles(storagePath, {
    ...catalogDependencies(exact, similarlyNamed),
    currentRuntime: differentRuntime,
  });
  expect(runtimeLedger.revisions.find((item) => item.id === edited.id)?.evidenceState).toBe(
    "Stale",
  );
  await expect(
    publishSharedModel(
      storagePath,
      {
        name: "Wrong runtime attempt",
        revisionId: edited.id,
        limits: { contextTokens: 1024, outputTokens: 128, concurrentRequests: 1 },
        capabilities: ["text"],
      },
      {
        ...catalogDependencies(exact, similarlyNamed),
        currentRuntime: differentRuntime,
      },
    ),
  ).rejects.toThrow("runtime");
});

async function passingRevision(
  storagePath: string,
  name: string,
  model: InstalledModel,
  runtime: RunProfileRuntime,
  contextSize: number,
) {
  const revision = await createRunProfile(
    storagePath,
    {
      name,
      modelId: model.id,
      runtime,
      chatTemplate: "{{ messages }}",
      controls: { ...controls(), contextSize },
      estimates: { projectedRamBytes: null, projectedGpuBytes: null },
    },
    catalogDependencies(model),
  );
  await testRunProfile(
    storagePath,
    revision.id,
    passingObservation(revision.id, model, runtime, contextSize),
    catalogDependencies(model),
  );
  return revision;
}

function passingObservation(
  revisionId: string,
  model: InstalledModel,
  runtime: RunProfileRuntime,
  contextSize = 4096,
): ProfileTestObservation {
  return {
    revisionId,
    effective: {
      modelId: model.id,
      modelFiles: model.files.map(({ role, sha256 }) => ({ role, sha256 })),
      runtime,
      chatTemplateSha256: Bun.CryptoHasher.hash("sha256", "{{ messages }}", "hex"),
      controls: { ...controls(), contextSize },
      contextPerSlot: contextSize,
      slotCount: 2,
      kvLayout: "unified",
      placement: "Metal:0",
      builtInTools: false,
      builtInAgent: false,
      automaticFit: false,
    },
    load: { passed: true },
    health: { passed: true },
    textResponse: { passed: true, outputTokens: 4 },
    cancellation: { passed: true, slotReleasedMs: 20 },
    stop: { passed: true, graceful: true },
    resources: { peakRamBytes: 620_000_000, peakGpuBytes: 410_000_000 },
    performance: {
      loadTimeMs: 1200,
      firstTokenTimeMs: 90,
      throughputTokensPerSecond: 14.5,
    },
    host: {
      hardware: "Apple M1 Max",
      devices: ["Metal:0"],
      osVersion: "macOS 27.0",
    },
    optionalCapabilities: {
      imageInput: "Unavailable",
      browserTools: "Unavailable",
      toolRunnerFunctions: "Unavailable",
    },
    failure: null,
  };
}

function controls(): RunProfileControls {
  return {
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
  };
}

function pinnedRuntime(): RunProfileRuntime {
  return {
    build: "b10107",
    commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
    binarySha256: "e".repeat(64),
  };
}

function installedModel(overrides: Partial<InstalledModel> = {}): InstalledModel {
  return {
    id: "f".repeat(64),
    displayName: "Family Model",
    available: true,
    architecture: "qwen2",
    parameterCount: 500_000_000,
    quantization: { fileType: 12, tensorTypes: { Q4_K: 1 } },
    trainingContext: 32_768,
    templateHints: ["{{ messages }}"],
    files: [
      {
        fileName: "family.gguf",
        role: "model",
        path: "/models/family.gguf",
        size: 400_000_000,
        sha256: "a".repeat(64),
        managed: true,
        shard: null,
      },
      {
        fileName: "projector.gguf",
        role: "companion",
        path: "/models/projector.gguf",
        size: 50_000_000,
        sha256: "b".repeat(64),
        managed: true,
        shard: null,
      },
    ],
    acquiredAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function catalogDependencies(...models: InstalledModel[]) {
  let id = 0;
  return {
    inspectModels: async () => models,
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    randomId: () => `id-${++id}`,
  };
}

async function modelStorage(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), "dist", "run-profile-test-"));
  roots.push(root);
  await mkdir(join(root, ".localhub-catalog"), { mode: 0o700 });
  return root;
}
