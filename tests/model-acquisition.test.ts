import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { prepareModelStorage } from "../src/guided-native.ts";
import {
  importLocalModel,
  inspectModelAcquisitions,
  inspectInstalledModels,
  prepareLocalModel,
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

async function isolatedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "localhub-model-test-"));
  roots.push(root);
  return root;
}

function gguf(options: {
  architecture: string;
  name: string;
  contextLength: number;
  chatTemplate?: string;
  tensor?: { type: number; elements: number; storedBytes: number };
  split?: { index: number; count: number; tensorCount: number };
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
