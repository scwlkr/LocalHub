import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { prepareModelStorage } from "../src/guided-native.ts";
import {
  discardModelAcquisition,
  importLocalModel,
  inspectInstalledModels,
  inspectModelAcquisitions,
  MODEL_STATE_SCHEMA,
  prepareLocalModel,
  renameInstalledModel,
} from "../src/model-acquisition.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("an exact outside GGUF is copied, verified, and atomically installed without changing its source", async () => {
  const root = await isolatedRoot();
  const sourceDirectory = join(root, "outside");
  const storagePath = join(root, "models");
  await mkdir(sourceDirectory);
  const sourcePath = join(sourceDirectory, "small-model.gguf");
  const sourceBytes = gguf({
    architecture: "qwen2",
    name: "Small Model",
    contextLength: 4096,
    chatTemplate: "{{ messages }}",
  });
  await writeFile(sourcePath, sourceBytes);
  await prepareModelStorage(storagePath);

  const acquisition = await prepareLocalModel(
    {
      displayName: "Kitchen Model",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-0001" },
  );

  expect(acquisition).toMatchObject({
    id: "acquisition-0001",
    status: "planned",
    displayName: "Kitchen Model",
    requiredBytes: sourceBytes.length,
    files: [
      {
        fileName: "small-model.gguf",
        role: "model",
        transfer: "copy",
        expectedSize: sourceBytes.length,
      },
    ],
  });
  expect(await inspectInstalledModels(storagePath)).toEqual([]);

  const installed = await importLocalModel(storagePath, acquisition.id);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

  expect(installed).toMatchObject({
    displayName: "Kitchen Model",
    available: true,
    architecture: "qwen2",
    parameterCount: 1,
    quantization: { fileType: 1, tensorTypes: { F32: 1 } },
    trainingContext: 4096,
    templateHints: ["{{ messages }}"],
    files: [
      {
        fileName: "small-model.gguf",
        role: "model",
        size: sourceBytes.length,
        sha256: sourceSha256,
        managed: true,
      },
    ],
  });
  expect(installed.id).toMatch(/^[0-9a-f]{64}$/);
  expect((await readFile(sourcePath)).equals(sourceBytes)).toBeTrue();
  expect((await readFile(installed.files[0]?.path ?? "")).equals(sourceBytes)).toBeTrue();
  expect(await inspectInstalledModels(storagePath)).toEqual([installed]);
});

test("an unsupported GGUF architecture fails precisely and creates no Installed Model", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "unsupported.gguf");
  await writeFile(
    sourcePath,
    gguf({ architecture: "future-unknown", name: "Unknown", contextLength: 1024 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Unknown",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-unsupported" },
  );

  await expect(importLocalModel(storagePath, acquisition.id)).rejects.toThrow(
    "Unsupported GGUF architecture future-unknown",
  );
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("Installed Model availability requires the exact verified bytes, not only the same path and size", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "availability.gguf");
  const sourceBytes = gguf({
    architecture: "qwen2",
    name: "Availability",
    contextLength: 2048,
  });
  await writeFile(sourcePath, sourceBytes);
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Availability",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-availability" },
  );
  const installed = await importLocalModel(storagePath, acquisition.id);
  const changedBytes = Buffer.from(sourceBytes);
  changedBytes[changedBytes.length - 1] = 9;

  await writeFile(installed.files[0]?.path ?? "", changedBytes);

  expect((await inspectInstalledModels(storagePath))[0]?.available).toBeFalse();
  await writeFile(installed.files[0]?.path ?? "", sourceBytes);
  expect((await inspectInstalledModels(storagePath))[0]?.available).toBeTrue();
});

test("a complete pinned Q4_K tensor layout is verified before installation", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "quantized.gguf");
  await writeFile(
    sourcePath,
    gguf({
      architecture: "qwen2",
      name: "Quantized",
      contextLength: 2048,
      tensor: { type: 12, elements: 256, storedBytes: 160 },
    }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Quantized",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-quantized" },
  );

  const installed = await importLocalModel(storagePath, acquisition.id);

  expect(installed.parameterCount).toBe(256);
  expect(installed.quantization.tensorTypes).toEqual({ Q4_K: 1 });
});

test("a complete split GGUF is ordered by embedded shard identity before one atomic install", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const first = join(root, "tiny-00001-of-00002.gguf");
  const second = join(root, "tiny-00002-of-00002.gguf");
  await writeFile(
    first,
    gguf({
      architecture: "qwen2",
      name: "Tiny Split",
      contextLength: 2048,
      split: { index: 0, count: 2, tensorCount: 2 },
    }),
  );
  await writeFile(
    second,
    gguf({
      architecture: "qwen2",
      name: "Tiny Split",
      contextLength: 2048,
      split: { index: 1, count: 2, tensorCount: 2 },
    }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Tiny Split",
      files: [
        { path: second, role: "model" },
        { path: first, role: "model" },
      ],
      storagePath,
    },
    { acquisitionId: () => "acquisition-split" },
  );

  const installed = await importLocalModel(storagePath, acquisition.id);

  expect(installed.files.map((file) => file.fileName)).toEqual([
    "tiny-00001-of-00002.gguf",
    "tiny-00002-of-00002.gguf",
  ]);
  expect(installed.parameterCount).toBe(2);
});

test("a selected non-projector companion fails without installing the otherwise valid model", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const modelPath = join(root, "model.gguf");
  const companionPath = join(root, "companion.gguf");
  await writeFile(
    modelPath,
    gguf({ architecture: "qwen2vl", name: "Vision Model", contextLength: 4096 }),
  );
  await writeFile(
    companionPath,
    gguf({ architecture: "qwen2", name: "Not a projector", contextLength: 4096 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Vision Model",
      files: [
        { path: modelPath, role: "model" },
        { path: companionPath, role: "companion" },
      ],
      storagePath,
    },
    { acquisitionId: () => "acquisition-wrong-companion" },
  );

  await expect(importLocalModel(storagePath, acquisition.id)).rejects.toThrow(
    "Wrong companion GGUF companion.gguf",
  );
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("an exact projector companion is verified and included in content identity", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const modelPath = join(root, "vision.gguf");
  const companionPath = join(root, "projector.gguf");
  await writeFile(
    modelPath,
    gguf({ architecture: "qwen2vl", name: "Vision Model", contextLength: 4096 }),
  );
  await writeFile(
    companionPath,
    gguf({
      architecture: "clip",
      name: "Vision Projector",
      contextLength: 4096,
      projectorType: "qwen2vl_merger",
    }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Vision Model",
      files: [
        { path: modelPath, role: "model" },
        { path: companionPath, role: "companion" },
      ],
      storagePath,
    },
    { acquisitionId: () => "acquisition-projector" },
  );

  const installed = await importLocalModel(storagePath, acquisition.id);

  expect(installed.files.map((file) => file.role)).toEqual(["model", "companion"]);
  expect(installed.id).toMatch(/^[0-9a-f]{64}$/);
});

test("a clip companion with an unknown pinned projector type fails before installation", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const modelPath = join(root, "model.gguf");
  const companionPath = join(root, "unknown-projector.gguf");
  await writeFile(
    modelPath,
    gguf({ architecture: "qwen2vl", name: "Vision Model", contextLength: 4096 }),
  );
  await writeFile(
    companionPath,
    gguf({
      architecture: "clip",
      name: "Unknown Projector",
      contextLength: 4096,
      projectorType: "future-projector",
    }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Unknown Projector",
      files: [
        { path: modelPath, role: "model" },
        { path: companionPath, role: "companion" },
      ],
      storagePath,
    },
    { acquisitionId: () => "acquisition-unknown-projector" },
  );

  await expect(importLocalModel(storagePath, acquisition.id)).rejects.toThrow(
    "Wrong companion GGUF unknown-projector.gguf",
  );
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("an interrupted copy remains explicitly Incomplete and resumes only the same source", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "resumable.gguf");
  await writeFile(
    sourcePath,
    gguf({ architecture: "qwen2", name: "Resumable", contextLength: 2048 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Resumable",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-interrupted" },
  );
  let interrupted = false;

  await expect(
    importLocalModel(storagePath, acquisition.id, {
      copyChunkBytes: 16,
      afterCopyChunk: () => {
        if (!interrupted) {
          interrupted = true;
          throw new Error("controlled interruption");
        }
      },
    }),
  ).rejects.toThrow("Local copy interrupted");
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
  expect(await inspectModelAcquisitions(storagePath)).toMatchObject([
    {
      id: acquisition.id,
      status: "incomplete",
      files: [{ receivedBytes: 16 }],
      failure: expect.stringContaining("controlled interruption"),
    },
  ]);

  const installed = await importLocalModel(storagePath, acquisition.id, { copyChunkBytes: 16 });

  expect(installed.available).toBeTrue();
  expect((await inspectModelAcquisitions(storagePath))[0]).toMatchObject({
    status: "installed",
    installedModelId: installed.id,
  });
});

test("a source changed during local copy is rejected after transfer and never installed", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "changing.gguf");
  const sourceBytes = gguf({ architecture: "qwen2", name: "Changing", contextLength: 2048 });
  const changedBytes = Buffer.from(sourceBytes);
  changedBytes[changedBytes.length - 1] = 9;
  await writeFile(sourcePath, sourceBytes);
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Changing",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-changing" },
  );

  await expect(
    importLocalModel(storagePath, acquisition.id, {
      copyChunkBytes: sourceBytes.length,
      afterCopyChunk: async () => await writeFile(sourcePath, changedBytes),
    }),
  ).rejects.toThrow("Selected local source changed after confirmation");
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("discard removes only incomplete staging and never an Installed Model", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "discard.gguf");
  const sourceBytes = gguf({ architecture: "qwen2", name: "Discard", contextLength: 2048 });
  await writeFile(sourcePath, sourceBytes);
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Discard",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-discard" },
  );
  await expect(
    importLocalModel(storagePath, acquisition.id, {
      copyChunkBytes: 16,
      afterCopyChunk: () => {
        throw new Error("pause before discard");
      },
    }),
  ).rejects.toThrow("Local copy interrupted");

  const discarded = await discardModelAcquisition(storagePath, acquisition.id);

  expect(discarded).toMatchObject({ status: "discarded", failure: null });
  expect(
    await Bun.file(join(storagePath, ".localhub-staging", acquisition.id)).exists(),
  ).toBeFalse();
  expect((await readFile(sourcePath)).equals(sourceBytes)).toBeTrue();
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("a source lexically inside storage but physically outside is copied, not adopted", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const outsidePath = join(root, "outside");
  await mkdir(storagePath);
  await mkdir(outsidePath);
  await prepareModelStorage(storagePath);
  await writeFile(
    join(outsidePath, "aliased.gguf"),
    gguf({ architecture: "qwen2", name: "Aliased", contextLength: 2048 }),
  );
  await symlink(outsidePath, join(storagePath, "outside-alias"));

  const acquisition = await prepareLocalModel(
    {
      displayName: "Aliased",
      files: [{ path: join(storagePath, "outside-alias", "aliased.gguf"), role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-aliased" },
  );

  expect(acquisition.files[0]?.transfer).toBe("copy");
  expect(acquisition.requiredBytes).toBeGreaterThan(0);
});

test("an atomic promotion failure leaves verified staging uninstalled", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "promotion.gguf");
  await writeFile(
    sourcePath,
    gguf({ architecture: "qwen2", name: "Promotion", contextLength: 2048 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Promotion",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-promotion" },
  );

  await expect(
    importLocalModel(storagePath, acquisition.id, {
      renamePath: async () => {
        throw new Error("controlled atomic promotion failure");
      },
    }),
  ).rejects.toThrow("controlled atomic promotion failure");
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
  expect((await inspectModelAcquisitions(storagePath))[0]).toMatchObject({
    status: "failed",
    installedModelId: null,
    failure: "controlled atomic promotion failure",
  });
});

test("inside-storage adoption, duplicate import, and display rename preserve one content identity", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const sourcePath = join(storagePath, "host-selected.gguf");
  const sourceBytes = gguf({
    architecture: "qwen2",
    name: "Host Selected",
    contextLength: 2048,
  });
  await writeFile(sourcePath, sourceBytes);
  const first = await prepareLocalModel(
    {
      displayName: "Original Label",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-adopt" },
  );
  expect(first.files[0]).toMatchObject({ transfer: "adopt", receivedBytes: 0 });
  const installed = await importLocalModel(storagePath, first.id);
  expect(installed.files[0]).toMatchObject({ path: sourcePath, managed: false });
  expect(await readdir(join(storagePath, ".localhub-staging"))).not.toContain(first.id);

  const renamed = await renameInstalledModel(storagePath, installed.id, "Renamed Label");

  expect(renamed).toMatchObject({ id: installed.id, displayName: "Renamed Label" });
  expect((await readFile(sourcePath)).equals(sourceBytes)).toBeTrue();
  const duplicate = await prepareLocalModel(
    {
      displayName: "Duplicate Label",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-duplicate" },
  );
  const reused = await importLocalModel(storagePath, duplicate.id);
  expect(reused).toMatchObject({ id: installed.id, displayName: "Renamed Label" });
  expect(await inspectInstalledModels(storagePath)).toHaveLength(1);
});

test("two frozen plans cannot install different content under one case-insensitive display name", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const firstPath = join(root, "first.gguf");
  const secondPath = join(root, "second.gguf");
  await writeFile(firstPath, gguf({ architecture: "qwen2", name: "First", contextLength: 2048 }));
  await writeFile(secondPath, gguf({ architecture: "qwen2", name: "Second", contextLength: 2048 }));
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const first = await prepareLocalModel(
    {
      displayName: "Shared Label",
      files: [{ path: firstPath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-first-label" },
  );
  const second = await prepareLocalModel(
    {
      displayName: "shared label",
      files: [{ path: secondPath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-second-label" },
  );

  await importLocalModel(storagePath, first.id);

  await expect(importLocalModel(storagePath, second.id)).rejects.toThrow(
    "Installed Model display name is already in use",
  );
  expect(await inspectInstalledModels(storagePath)).toHaveLength(1);
});

test("preparation rejects two exact selections with the same destination filename", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  await mkdir(storagePath);
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  await prepareModelStorage(storagePath);
  await writeFile(
    join(firstDirectory, "model.gguf"),
    gguf({ architecture: "qwen2", name: "First", contextLength: 2048 }),
  );
  await writeFile(
    join(secondDirectory, "model.gguf"),
    gguf({ architecture: "qwen2", name: "Second", contextLength: 2048 }),
  );

  await expect(
    prepareLocalModel({
      displayName: "Repeated Filename",
      files: [
        { path: join(firstDirectory, "model.gguf"), role: "model" },
        { path: join(secondDirectory, "model.gguf"), role: "model" },
      ],
      storagePath,
    }),
  ).rejects.toThrow("Selected local filename is repeated");
  expect(await inspectModelAcquisitions(storagePath)).toEqual([]);
});

test("a malformed catalog acquisition cannot escape staging during discard", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const protectedDirectory = join(storagePath, "protected");
  const protectedFile = join(protectedDirectory, "keep.txt");
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  await mkdir(protectedDirectory);
  await writeFile(protectedFile, "keep");
  await writeFile(
    join(storagePath, ".localhub-catalog", "models.json"),
    `${JSON.stringify({
      schema: MODEL_STATE_SCHEMA,
      acquisitions: [
        {
          id: "../../protected",
          status: "failed",
          displayName: "Unsafe",
          storagePath,
          requiredBytes: 0,
          availableBytes: 0,
          files: [],
          installedModelId: null,
          failure: "malformed",
        },
      ],
      installedModels: [],
    })}\n`,
  );

  await expect(discardModelAcquisition(storagePath, "../../protected")).rejects.toThrow(
    "Model catalog is incomplete or malformed",
  );
  expect(await readFile(protectedFile, "utf8")).toBe("keep");
});

test("an unreadable selected file fails precisely before an acquisition is recorded", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "unreadable.gguf");
  await writeFile(
    sourcePath,
    gguf({ architecture: "qwen2", name: "Unreadable", contextLength: 2048 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);

  await expect(
    prepareLocalModel(
      {
        displayName: "Unreadable",
        files: [{ path: sourcePath, role: "model" }],
        storagePath,
      },
      { confirmReadable: async () => await Promise.reject(new Error("controlled read denial")) },
    ),
  ).rejects.toThrow("Selected local GGUF is unreadable");
  expect(await inspectModelAcquisitions(storagePath)).toEqual([]);
});

test("insufficient Model Storage fails before copy or acquisition state", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "too-large.gguf");
  await writeFile(
    sourcePath,
    gguf({ architecture: "qwen2", name: "Too Large", contextLength: 2048 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);

  await expect(
    prepareLocalModel(
      {
        displayName: "Too Large",
        files: [{ path: sourcePath, role: "model" }],
        storagePath,
      },
      { availableBytes: async () => 1 },
    ),
  ).rejects.toThrow("No bytes were copied");
  expect(await inspectModelAcquisitions(storagePath)).toEqual([]);
});

test("malformed bytes and a supplied digest mismatch fail without an Installed Model", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const malformedPath = join(root, "malformed.gguf");
  const mismatchPath = join(root, "mismatch.gguf");
  await writeFile(malformedPath, "not a GGUF");
  await writeFile(
    mismatchPath,
    gguf({ architecture: "qwen2", name: "Mismatch", contextLength: 2048 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const malformed = await prepareLocalModel(
    {
      displayName: "Malformed",
      files: [{ path: malformedPath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-malformed" },
  );
  await expect(importLocalModel(storagePath, malformed.id)).rejects.toThrow(
    "magic bytes are not GGUF",
  );
  const mismatch = await prepareLocalModel(
    {
      displayName: "Mismatch",
      files: [{ path: mismatchPath, role: "model", publishedSha256: "0".repeat(64) }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-mismatch" },
  );
  await expect(importLocalModel(storagePath, mismatch.id)).rejects.toThrow(
    "Published SHA-256 mismatch",
  );
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("a missing shard and a vanished exact source fail without choosing a similar filename", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const shardPath = join(root, "split-00001-of-00002.gguf");
  const exactPath = join(root, "chosen.gguf");
  const similarPath = join(root, "chosen-copy.gguf");
  const bytes = gguf({ architecture: "qwen2", name: "Chosen", contextLength: 2048 });
  await writeFile(
    shardPath,
    gguf({
      architecture: "qwen2",
      name: "Split",
      contextLength: 2048,
      split: { index: 0, count: 2, tensorCount: 2 },
    }),
  );
  await writeFile(exactPath, bytes);
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const missingShard = await prepareLocalModel(
    {
      displayName: "Missing Shard",
      files: [{ path: shardPath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-missing-shard" },
  );
  await expect(importLocalModel(storagePath, missingShard.id)).rejects.toThrow(
    "Missing GGUF shard",
  );
  const exact = await prepareLocalModel(
    {
      displayName: "Chosen",
      files: [{ path: exactPath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-no-substitution" },
  );
  await rm(exactPath);
  await writeFile(similarPath, bytes);

  await expect(importLocalModel(storagePath, exact.id)).rejects.toThrow(
    "No similarly named file was substituted",
  );
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
});

test("a catalog-commit failure rolls promoted bytes back to uninstalled staging", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "catalog.gguf");
  await writeFile(
    sourcePath,
    gguf({ architecture: "qwen2", name: "Catalog", contextLength: 2048 }),
  );
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);
  const acquisition = await prepareLocalModel(
    {
      displayName: "Catalog",
      files: [{ path: sourcePath, role: "model" }],
      storagePath,
    },
    { acquisitionId: () => "acquisition-catalog" },
  );

  await expect(
    importLocalModel(storagePath, acquisition.id, {
      beforeCatalogCommit: () => {
        throw new Error("controlled catalog commit failure");
      },
    }),
  ).rejects.toThrow("controlled catalog commit failure");
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
  expect((await inspectModelAcquisitions(storagePath))[0]).toMatchObject({
    status: "failed",
    installedModelId: null,
  });
});

test("shipped Host commands separate exact preparation from import, inventory, and rename", async () => {
  const root = await isolatedRoot();
  const storagePath = join(root, "models");
  const sourcePath = join(root, "command.gguf");
  const sourceBytes = gguf({
    architecture: "qwen2",
    name: "Command Model",
    contextLength: 2048,
  });
  await writeFile(sourcePath, sourceBytes);
  await mkdir(storagePath);
  await prepareModelStorage(storagePath);

  const prepared = await captureOutput(() =>
    main(["model", "prepare", "--name", "Command Model", "--file", sourcePath], {
      modelStoragePath: storagePath,
    }),
  );

  expect(prepared.code).toBe(0);
  const acquisition = JSON.parse(prepared.logs.join("\n")) as { id: string; status: string };
  expect(acquisition.status).toBe("planned");
  expect(await inspectInstalledModels(storagePath)).toEqual([]);
  const imported = await captureOutput(() =>
    main(["model", "import", acquisition.id], { modelStoragePath: storagePath }),
  );
  expect(imported.code).toBe(0);
  const model = JSON.parse(imported.logs.join("\n")) as { id: string };
  const listed = await captureOutput(() =>
    main(["model", "list"], { modelStoragePath: storagePath }),
  );
  expect(JSON.parse(listed.logs.join("\n"))).toMatchObject([
    { id: model.id, displayName: "Command Model", available: true },
  ]);
  const renamed = await captureOutput(() =>
    main(["model", "rename", model.id, "Family Model"], {
      modelStoragePath: storagePath,
    }),
  );
  expect(JSON.parse(renamed.logs.join("\n"))).toMatchObject({
    id: model.id,
    displayName: "Family Model",
  });
  expect((await readFile(sourcePath)).equals(sourceBytes)).toBeTrue();
});

async function isolatedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "localhub-model-test-"));
  roots.push(root);
  return root;
}

async function captureOutput(
  run: () => Promise<number>,
): Promise<{ code: number; logs: string[] }> {
  const original = console.log;
  const logs: string[] = [];
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  try {
    return { code: await run(), logs };
  } finally {
    console.log = original;
  }
}

function gguf(options: {
  architecture: string;
  name: string;
  contextLength: number;
  chatTemplate?: string;
  tensor?: { type: number; elements: number; storedBytes: number };
  split?: { index: number; count: number; tensorCount: number };
  projectorType?: string;
}): Buffer {
  const metadata: Buffer[] = [
    kvString("general.architecture", options.architecture),
    kvString("general.name", options.name),
    kvUint32("general.file_type", 1),
    kvUint32(`${options.architecture}.context_length`, options.contextLength),
  ];
  if (options.chatTemplate) {
    metadata.push(kvString("tokenizer.chat_template", options.chatTemplate));
  }
  if (options.projectorType) {
    metadata.push(kvString("clip.projector_type", options.projectorType));
  }
  if (options.split) {
    metadata.push(
      kvUint16("split.no", options.split.index),
      kvUint16("split.count", options.split.count),
      kvUint32("split.tensors.count", options.split.tensorCount),
    );
  }
  const tensorName = ggufString("weight");
  const tensor = options.tensor ?? { type: 0, elements: 1, storedBytes: 32 };
  const tensorInfo = Buffer.concat([
    tensorName,
    uint32(1),
    uint64(tensor.elements),
    uint32(tensor.type),
    uint64(0),
  ]);
  const header = Buffer.concat([
    Buffer.from("GGUF"),
    uint32(3),
    uint64(1),
    uint64(metadata.length),
    ...metadata,
    tensorInfo,
  ]);
  const padding = Buffer.alloc((32 - (header.length % 32)) % 32);
  return Buffer.concat([header, padding, Buffer.alloc(tensor.storedBytes, 7)]);
}

function kvString(key: string, value: string): Buffer {
  return Buffer.concat([ggufString(key), uint32(8), ggufString(value)]);
}

function kvUint32(key: string, value: number): Buffer {
  return Buffer.concat([ggufString(key), uint32(4), uint32(value)]);
}

function kvUint16(key: string, value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return Buffer.concat([ggufString(key), uint32(2), bytes]);
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint64(bytes.length), bytes]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}
