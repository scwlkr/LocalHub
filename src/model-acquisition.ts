import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MODEL_STATE_SCHEMA = "localhub.model-state/v1";

export interface LocalModelSelection {
  path: string;
  role: "model" | "companion";
  publishedSha256?: string;
}

export interface PrepareLocalModelOptions {
  storagePath: string;
  displayName: string;
  files: LocalModelSelection[];
}

export interface ModelMutationDependencies {
  lockDeadlineMs?: number;
  lockRetryMs?: number;
  processAlive?: (pid: number) => boolean;
}

export interface ModelAcquisitionDependencies extends ModelMutationDependencies {
  acquisitionId?: () => string;
  availableBytes?: (storagePath: string) => Promise<number>;
  confirmReadable?: (path: string) => Promise<void>;
}

export interface ModelImportDependencies extends ModelMutationDependencies {
  copyChunkBytes?: number;
  afterCopyChunk?: (copiedBytes: number) => Promise<void> | void;
  renamePath?: (oldPath: string, newPath: string) => Promise<void>;
  beforeCatalogCommit?: () => Promise<void> | void;
}

interface SourceIdentity {
  device: string;
  inode: string;
  modifiedNanoseconds: string;
  size: number;
}

export interface PlannedModelFile {
  sourcePath: string;
  fileName: string;
  role: "model" | "companion";
  transfer: "adopt" | "copy";
  expectedSize: number;
  receivedBytes: number;
  publishedSha256: string | null;
  sourceIdentity: SourceIdentity;
}

export interface ModelAcquisition {
  id: string;
  status: "planned" | "incomplete" | "failed" | "installed" | "discarded";
  displayName: string;
  storagePath: string;
  requiredBytes: number;
  availableBytes: number;
  files: PlannedModelFile[];
  installedModelId: string | null;
  failure: string | null;
}

export interface InstalledModelFile {
  fileName: string;
  role: "model" | "companion";
  path: string;
  size: number;
  sha256: string;
  managed: boolean;
  shard: { index: number; count: number } | null;
}

export interface InstalledModel {
  id: string;
  displayName: string;
  available: boolean;
  architecture: string;
  parameterCount: number;
  quantization: {
    fileType: number | null;
    tensorTypes: Record<string, number>;
  };
  trainingContext: number | null;
  templateHints: string[];
  files: InstalledModelFile[];
  acquiredAt: string;
}

interface ModelState {
  schema: typeof MODEL_STATE_SCHEMA;
  acquisitions: ModelAcquisition[];
  installedModels: InstalledModel[];
}

interface PromotionJournal {
  schema: "localhub.model-promotion/v1";
  acquisitionId: string;
  installed: InstalledModel;
}

interface GgufInspection {
  architecture: string;
  name: string | null;
  parameterCount: number;
  tensorCount: number;
  fileType: number | null;
  tensorTypes: Record<string, number>;
  trainingContext: number | null;
  templateHints: string[];
  projectorTypes: string[];
  split: { index: number; count: number; tensorCount: number } | null;
}

const MANAGED_DIRECTORIES = new Set([".localhub-catalog", ".localhub-models", ".localhub-staging"]);
const PROMOTION_SCHEMA = "localhub.model-promotion/v1";
const MUTATION_LOCK_NAME = "mutation.lock";
const PROMOTION_JOURNAL_NAME = "promotion.json";
const TENSOR_TYPES = new Map<number, { name: string; blockSize: number; typeSize: number }>([
  [0, { name: "F32", blockSize: 1, typeSize: 4 }],
  [1, { name: "F16", blockSize: 1, typeSize: 2 }],
  [2, { name: "Q4_0", blockSize: 32, typeSize: 18 }],
  [3, { name: "Q4_1", blockSize: 32, typeSize: 20 }],
  [6, { name: "Q5_0", blockSize: 32, typeSize: 22 }],
  [7, { name: "Q5_1", blockSize: 32, typeSize: 24 }],
  [8, { name: "Q8_0", blockSize: 32, typeSize: 34 }],
  [9, { name: "Q8_1", blockSize: 32, typeSize: 36 }],
  [10, { name: "Q2_K", blockSize: 256, typeSize: 84 }],
  [11, { name: "Q3_K", blockSize: 256, typeSize: 110 }],
  [12, { name: "Q4_K", blockSize: 256, typeSize: 144 }],
  [13, { name: "Q5_K", blockSize: 256, typeSize: 176 }],
  [14, { name: "Q6_K", blockSize: 256, typeSize: 210 }],
  [15, { name: "Q8_K", blockSize: 256, typeSize: 292 }],
  [16, { name: "IQ2_XXS", blockSize: 256, typeSize: 66 }],
  [17, { name: "IQ2_XS", blockSize: 256, typeSize: 74 }],
  [18, { name: "IQ3_XXS", blockSize: 256, typeSize: 98 }],
  [19, { name: "IQ1_S", blockSize: 256, typeSize: 50 }],
  [20, { name: "IQ4_NL", blockSize: 32, typeSize: 18 }],
  [21, { name: "IQ3_S", blockSize: 256, typeSize: 110 }],
  [22, { name: "IQ2_S", blockSize: 256, typeSize: 82 }],
  [23, { name: "IQ4_XS", blockSize: 256, typeSize: 136 }],
  [24, { name: "I8", blockSize: 1, typeSize: 1 }],
  [25, { name: "I16", blockSize: 1, typeSize: 2 }],
  [26, { name: "I32", blockSize: 1, typeSize: 4 }],
  [27, { name: "I64", blockSize: 1, typeSize: 8 }],
  [28, { name: "F64", blockSize: 1, typeSize: 8 }],
  [29, { name: "IQ1_M", blockSize: 256, typeSize: 56 }],
  [30, { name: "BF16", blockSize: 1, typeSize: 2 }],
  [34, { name: "TQ1_0", blockSize: 256, typeSize: 54 }],
  [35, { name: "TQ2_0", blockSize: 256, typeSize: 66 }],
  [39, { name: "MXFP4", blockSize: 32, typeSize: 17 }],
  [40, { name: "NVFP4", blockSize: 64, typeSize: 36 }],
  [41, { name: "Q1_0", blockSize: 128, typeSize: 18 }],
  [42, { name: "Q2_0", blockSize: 64, typeSize: 18 }],
]);
const PINNED_LLAMA_ARCHITECTURES = new Set(
  "llama llama4 deci falcon grok gpt2 gptj gptneox mpt baichuan starcoder refact bert modern-bert nomic-bert nomic-bert-moe neo-bert jina-bert-v2 jina-bert-v3 eurobert bloom stablelm qwen qwen2 qwen2moe qwen2vl qwen3 qwen3moe qwen3next qwen3vl qwen3vlmoe qwen35 qwen35moe phi2 phi3 phimoe plamo plamo2 plamo3 codeshell orion internlm2 minicpm minicpm3 gemma gemma2 gemma3 gemma3n gemma4 gemma4-assistant gemma-embedding starcoder2 mamba mamba2 jamba falcon-h1 xverse command-r cohere2 cohere2moe dbrx olmo olmo2 olmoe openelm arctic deepseek deepseek2 deepseek2-ocr deepseek32 deepseek4 chatglm glm4 glm4moe glm-dsa bitnet t5 t5encoder jais jais2 nemotron nemotron_h nemotron_h_moe exaone exaone4 exaone-moe rwkv6 rwkv6qwen2 rwkv7 arwkv7 granite granitemoe granitehybrid chameleon wavtokenizer-dec plm bailingmoe bailingmoe2 dots1 arcee afmoe laguna ernie4_5 ernie4_5-moe hunyuan-moe hunyuan-dense hunyuan_vl hy_v3 smollm3 gpt-oss lfm2 lfm2moe dream smallthinker llada llada-moe seed_oss grovemoe apertus minimax-m2 cogvlm rnd1 pangu-embedded mistral3 eagle3 dflash mistral4 paddleocr mimo2 step35 llama-embed maincoder kimi-linear talkie mellum".split(
    " ",
  ),
);
const PINNED_PROJECTOR_TYPES = new Set(
  "mlp ldp ldpv2 resampler adapter qwen2vl_merger qwen2.5vl_merger qwen3vl_merger step3vl gemma3 gemma3nv gemma3na gemma4v gemma4a gemma4uv gemma4ua phi4 idefics3 pixtral ultravox internvl llama4 qwen2a qwen3a glma qwen2.5o voxtral meralion musicflamingo lfm2 kimivl paddleocr lightonocr cogvlm janus_pro dots_ocr deepseekocr deepseekocr2 lfm2a glm4v youtuvl yasa2 kimik25 nemotron_v2_vl exaone4_5 hunyuanvl minicpmv4_6 granite_speech mimovl granite4_vision".split(
    " ",
  ),
);

export async function prepareLocalModel(
  options: PrepareLocalModelOptions,
  dependencies: ModelAcquisitionDependencies = {},
): Promise<ModelAcquisition> {
  const storagePath = resolve(options.storagePath);
  await assertManagedModelStorage(storagePath);
  if (!options.displayName.trim())
    throw new Error("Installed Model display name must not be empty.");
  if (options.files.length === 0) throw new Error("Select at least one exact local GGUF file.");
  if (options.files.filter((file) => file.role === "companion").length > 1) {
    throw new Error("Select at most one exact optional companion.");
  }

  const files: PlannedModelFile[] = [];
  const selectedPaths = new Set<string>();
  const selectedFileNames = new Set<string>();
  const canonicalStoragePath = await realpath(storagePath);
  for (const selected of options.files) {
    const sourcePath = resolve(selected.path);
    if (selectedPaths.has(sourcePath))
      throw new Error(`Selected local file is repeated: ${sourcePath}`);
    selectedPaths.add(sourcePath);
    if (!sourcePath.toLowerCase().endsWith(".gguf")) {
      throw new Error(`Selected local file is not GGUF: ${sourcePath}`);
    }
    const fileName = basename(sourcePath);
    const foldedFileName = fileName.toLocaleLowerCase("en-US");
    if (selectedFileNames.has(foldedFileName)) {
      throw new Error(`Selected local filename is repeated: ${fileName}`);
    }
    selectedFileNames.add(foldedFileName);
    const source = await readableRegularFile(sourcePath);
    try {
      await dependencies.confirmReadable?.(sourcePath);
    } catch (error) {
      throw new Error(`Selected local GGUF is unreadable: ${sourcePath}. ${errorMessage(error)}`);
    }
    const canonicalSourcePath = await realpath(sourcePath);
    const insideStorage = pathInside(canonicalStoragePath, canonicalSourcePath);
    if (
      insideStorage &&
      MANAGED_DIRECTORIES.has(
        relative(canonicalStoragePath, canonicalSourcePath).split(/[\\/]/)[0] ?? "",
      )
    ) {
      throw new Error(`Select a source outside LocalHub's managed Model Storage directories.`);
    }
    const publishedSha256 = selected.publishedSha256?.toLowerCase() ?? null;
    if (publishedSha256 !== null && !/^[0-9a-f]{64}$/.test(publishedSha256)) {
      throw new Error(`Published SHA-256 is malformed for ${sourcePath}.`);
    }
    files.push({
      sourcePath,
      fileName,
      role: selected.role,
      transfer: insideStorage ? "adopt" : "copy",
      expectedSize: source.size,
      receivedBytes: 0,
      publishedSha256,
      sourceIdentity: source.identity,
    });
  }

  const requiredBytes = files
    .filter((file) => file.transfer === "copy")
    .reduce((total, file) => total + file.expectedSize, 0);
  const availableBytes = await (dependencies.availableBytes ?? modelStorageAvailableBytes)(
    storagePath,
  );
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Model Storage has ${availableBytes} bytes free but this exact local acquisition requires ${requiredBytes} bytes. No bytes were copied.`,
    );
  }

  return await withModelCatalogMutationLock(storagePath, dependencies, async () => {
    const state = await readReconciledModelState(storagePath);
    const foldedName = options.displayName.trim().toLocaleLowerCase("en-US");
    if (
      state.installedModels.some(
        (model) => model.displayName.toLocaleLowerCase("en-US") === foldedName,
      )
    ) {
      throw new Error(
        `Installed Model display name is already in use: ${options.displayName.trim()}`,
      );
    }
    const acquisition: ModelAcquisition = {
      id: (dependencies.acquisitionId ?? randomUUID)(),
      status: "planned",
      displayName: options.displayName.trim(),
      storagePath,
      requiredBytes,
      availableBytes,
      files,
      installedModelId: null,
      failure: null,
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(acquisition.id)) {
      throw new Error("Model Acquisition identity is malformed.");
    }
    if (state.acquisitions.some((item) => item.id === acquisition.id)) {
      throw new Error(`Model Acquisition identity already exists: ${acquisition.id}`);
    }
    state.acquisitions.push(acquisition);
    await writeModelState(storagePath, state);
    return acquisition;
  });
}

export async function importLocalModel(
  storagePathValue: string,
  acquisitionId: string,
  dependencies: ModelImportDependencies = {},
): Promise<InstalledModel> {
  const storagePath = resolve(storagePathValue);
  await assertManagedModelStorage(storagePath);
  return await withModelCatalogMutationLock(
    storagePath,
    dependencies,
    async () => await importLocalModelLocked(storagePath, acquisitionId, dependencies),
  );
}

async function importLocalModelLocked(
  storagePath: string,
  acquisitionId: string,
  dependencies: ModelImportDependencies,
): Promise<InstalledModel> {
  const state = await readReconciledModelState(storagePath);
  const acquisition = state.acquisitions.find((item) => item.id === acquisitionId);
  if (!acquisition) throw new Error(`Unknown Model Acquisition: ${acquisitionId}`);
  if (acquisition.status === "installed" && acquisition.installedModelId) {
    const existing = state.installedModels.find(
      (model) => model.id === acquisition.installedModelId,
    );
    if (existing) return existing;
  }
  if (acquisition.status !== "planned" && acquisition.status !== "incomplete") {
    throw new Error(
      `Model Acquisition ${acquisitionId} is ${acquisition.status}; only a planned or incomplete acquisition can be imported.`,
    );
  }

  const stagingPath = join(storagePath, ".localhub-staging", acquisition.id);
  await mkdir(stagingPath, { recursive: true, mode: 0o700 });
  const staging = await lstat(stagingPath);
  if (!staging.isDirectory() || staging.isSymbolicLink()) {
    throw new Error(`Model Acquisition staging path is not a safe folder: ${acquisition.id}`);
  }
  acquisition.failure = null;
  let promotedDirectory: string | null = null;
  let promotionJournalWritten = false;
  let pendingInstalledId: string | null = null;
  try {
    const verifiable: Array<{ selected: PlannedModelFile; path: string; managed: boolean }> = [];
    for (const selected of acquisition.files) {
      await assertUnchangedSource(selected);
      if (selected.transfer === "adopt") {
        selected.receivedBytes = selected.expectedSize;
        verifiable.push({ selected, path: selected.sourcePath, managed: false });
      } else {
        const stagedPath = join(stagingPath, selected.fileName);
        await copyLocalSource({
          acquisition,
          selected,
          sourcePath: selected.sourcePath,
          stagedPath,
          state,
          storagePath,
          dependencies,
        });
        verifiable.push({ selected, path: stagedPath, managed: true });
      }
    }

    const verifiedFiles: Array<
      Omit<InstalledModelFile, "shard"> & { inspection: GgufInspection; stagedPath: string }
    > = [];
    for (const file of verifiable) {
      const [sha256, inspection] = await Promise.all([
        sha256File(file.path),
        inspectGguf(file.path),
      ]);
      await assertUnchangedSource(file.selected);
      if (file.selected.publishedSha256 && sha256 !== file.selected.publishedSha256) {
        throw new Error(
          `Published SHA-256 mismatch for ${file.selected.fileName}: expected ${file.selected.publishedSha256}, observed ${sha256}.`,
        );
      }
      verifiedFiles.push({
        fileName: file.selected.fileName,
        role: file.selected.role,
        path: file.path,
        size: file.selected.expectedSize,
        sha256,
        managed: file.managed,
        inspection,
        stagedPath: file.path,
      });
    }

    const modelFiles = orderAndVerifyModelFiles(
      verifiedFiles.filter((file) => file.role === "model"),
    );
    const companionFiles = verifiedFiles.filter((file) => file.role === "companion");
    for (const companion of companionFiles) {
      if (
        companion.inspection.architecture !== "clip" ||
        companion.inspection.projectorTypes.length === 0 ||
        companion.inspection.projectorTypes.some((type) => !PINNED_PROJECTOR_TYPES.has(type))
      ) {
        throw new Error(
          `Wrong companion GGUF ${companion.fileName}: expected clip architecture with embedded pinned projector identity.`,
        );
      }
    }
    const orderedFiles = [...modelFiles, ...companionFiles];
    const modelInspection = modelFiles[0]?.inspection;
    if (!modelInspection) throw new Error("The selected model GGUF was not verified.");
    if (!PINNED_LLAMA_ARCHITECTURES.has(modelInspection.architecture)) {
      throw new Error(
        `Unsupported GGUF architecture ${modelInspection.architecture} for pinned llama.cpp b10107.`,
      );
    }
    const manifest = orderedFiles.map((file) => ({
      role: file.role,
      shardIndex: file.inspection.split?.index ?? null,
      size: file.size,
      sha256: file.sha256,
    }));
    const id = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const duplicate = state.installedModels.find((model) => model.id === id);
    if (duplicate) {
      acquisition.status = "installed";
      acquisition.installedModelId = duplicate.id;
      await rm(stagingPath, { recursive: true, force: true });
      await writeModelState(storagePath, state);
      return duplicate;
    }
    const foldedName = acquisition.displayName.toLocaleLowerCase("en-US");
    if (
      state.installedModels.some(
        (model) => model.displayName.toLocaleLowerCase("en-US") === foldedName,
      )
    ) {
      throw new Error(`Installed Model display name is already in use: ${acquisition.displayName}`);
    }

    const finalDirectory = join(storagePath, ".localhub-models", id);
    const hasManagedFiles = orderedFiles.some((file) => file.managed);
    const installedFiles = orderedFiles.map<InstalledModelFile>((file) => ({
      fileName: file.fileName,
      role: file.role,
      path: file.managed ? join(finalDirectory, file.fileName) : file.path,
      size: file.size,
      sha256: file.sha256,
      managed: file.managed,
      shard: file.inspection.split
        ? { index: file.inspection.split.index, count: file.inspection.split.count }
        : null,
    }));
    const installed: InstalledModel = {
      id,
      displayName: acquisition.displayName,
      available: true,
      architecture: modelInspection.architecture,
      parameterCount: modelFiles.reduce((total, file) => total + file.inspection.parameterCount, 0),
      quantization: {
        fileType: modelInspection.fileType,
        tensorTypes: mergeTensorTypes(modelFiles.map((file) => file.inspection.tensorTypes)),
      },
      trainingContext: modelInspection.trainingContext,
      templateHints: modelInspection.templateHints,
      files: installedFiles,
      acquiredAt: new Date().toISOString(),
    };
    if (hasManagedFiles) {
      await writePromotionJournal(storagePath, {
        schema: PROMOTION_SCHEMA,
        acquisitionId: acquisition.id,
        installed,
      });
      promotionJournalWritten = true;
      await (dependencies.renamePath ?? rename)(stagingPath, finalDirectory);
      promotedDirectory = finalDirectory;
    } else {
      await rm(stagingPath, { recursive: true, force: true });
    }
    state.installedModels.push(installed);
    pendingInstalledId = installed.id;
    acquisition.status = "installed";
    acquisition.installedModelId = installed.id;
    await dependencies.beforeCatalogCommit?.();
    await writeModelState(storagePath, state);
    if (promotionJournalWritten) await removePromotionJournal(storagePath);
    return installed;
  } catch (error) {
    if (pendingInstalledId) {
      state.installedModels = state.installedModels.filter(
        (model) => model.id !== pendingInstalledId,
      );
      acquisition.installedModelId = null;
    }
    if (promotedDirectory) {
      try {
        await rename(promotedDirectory, stagingPath);
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)} Atomic promotion rollback failed: ${errorMessage(rollbackError)}`,
        );
      }
    }
    if (promotionJournalWritten) await removePromotionJournal(storagePath);
    acquisition.status = error instanceof LocalCopyInterruptedError ? "incomplete" : "failed";
    acquisition.failure = errorMessage(error);
    await writeModelState(storagePath, state);
    throw error;
  }
}

export async function inspectModelAcquisitions(
  storagePathValue: string,
): Promise<ModelAcquisition[]> {
  return (await readModelStateForInspection(resolve(storagePathValue))).acquisitions;
}

export async function renameInstalledModel(
  storagePathValue: string,
  modelId: string,
  displayNameValue: string,
  dependencies: ModelMutationDependencies = {},
): Promise<InstalledModel> {
  const storagePath = resolve(storagePathValue);
  const displayName = displayNameValue.trim();
  if (!displayName) throw new Error("Installed Model display name must not be empty.");
  return await withModelCatalogMutationLock(storagePath, dependencies, async () => {
    const state = await readReconciledModelState(storagePath);
    const model = state.installedModels.find((item) => item.id === modelId);
    if (!model) throw new Error(`Unknown Installed Model content identity: ${modelId}`);
    const foldedName = displayName.toLocaleLowerCase("en-US");
    if (
      state.installedModels.some(
        (item) => item.id !== modelId && item.displayName.toLocaleLowerCase("en-US") === foldedName,
      )
    ) {
      throw new Error(`Installed Model display name is already in use: ${displayName}`);
    }
    model.displayName = displayName;
    await writeModelState(storagePath, state);
    return { ...model, available: await installedFilesPresent(model.files) };
  });
}

export async function discardModelAcquisition(
  storagePathValue: string,
  acquisitionId: string,
  dependencies: ModelMutationDependencies = {},
): Promise<ModelAcquisition> {
  const storagePath = resolve(storagePathValue);
  return await withModelCatalogMutationLock(storagePath, dependencies, async () => {
    const state = await readReconciledModelState(storagePath);
    const acquisition = state.acquisitions.find((item) => item.id === acquisitionId);
    if (!acquisition) throw new Error(`Unknown Model Acquisition: ${acquisitionId}`);
    if (acquisition.status === "installed") {
      throw new Error(`Installed Model Acquisition ${acquisitionId} cannot be discarded.`);
    }
    if (acquisition.status === "discarded") return acquisition;
    await rm(join(storagePath, ".localhub-staging", acquisition.id), {
      recursive: true,
      force: true,
    });
    acquisition.status = "discarded";
    acquisition.failure = null;
    for (const file of acquisition.files) file.receivedBytes = 0;
    await writeModelState(storagePath, state);
    return acquisition;
  });
}

export async function inspectInstalledModels(storagePathValue: string): Promise<InstalledModel[]> {
  const storagePath = resolve(storagePathValue);
  const state = await readModelStateForInspection(storagePath);
  return await inspectInstalledModelsFromState(state);
}

export async function inspectInstalledModelsUnderCatalogLock(
  storagePathValue: string,
): Promise<InstalledModel[]> {
  const storagePath = resolve(storagePathValue);
  const state = await readReconciledModelState(storagePath);
  return await inspectInstalledModelsFromState(state);
}

async function inspectInstalledModelsFromState(state: ModelState): Promise<InstalledModel[]> {
  return await Promise.all(
    state.installedModels.map(async (model) => ({
      ...model,
      available: await installedFilesPresent(model.files),
    })),
  );
}

export async function assertManagedModelStorage(storagePath: string): Promise<void> {
  const root = await lstat(storagePath);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Model Storage must be the exact confirmed non-symbolic-link folder.");
  }
  for (const directory of MANAGED_DIRECTORIES) {
    const path = join(storagePath, directory);
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Managed Model Storage path ${directory} is not a safe folder.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(`Managed Model Storage path ${directory} is not a safe folder.`);
        }
      }
    }
  }
}

async function readableRegularFile(
  path: string,
): Promise<{ size: number; identity: SourceIdentity }> {
  const entry = await lstat(path, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Selected local GGUF is not a readable regular file: ${path}`);
  }
  try {
    const handle = await open(path, "r");
    await handle.close();
  } catch (error) {
    throw new Error(`Selected local GGUF is unreadable: ${path}. ${errorMessage(error)}`);
  }
  const size = safeNumber(entry.size, `Selected local GGUF is too large: ${path}`);
  return {
    size,
    identity: {
      device: entry.dev.toString(),
      inode: entry.ino.toString(),
      modifiedNanoseconds: entry.mtimeNs.toString(),
      size,
    },
  };
}

async function assertUnchangedSource(selected: PlannedModelFile): Promise<void> {
  let current: Awaited<ReturnType<typeof readableRegularFile>>;
  try {
    current = await readableRegularFile(selected.sourcePath);
  } catch (error) {
    throw new Error(
      `Selected local source is missing or unreadable: ${selected.sourcePath}. No similarly named file was substituted. ${errorMessage(error)}`,
    );
  }
  if (JSON.stringify(current.identity) !== JSON.stringify(selected.sourceIdentity)) {
    throw new Error(
      `Selected local source changed after confirmation: ${selected.sourcePath}. No bytes were imported and no similarly named file was substituted.`,
    );
  }
}

async function modelStorageAvailableBytes(storagePath: string): Promise<number> {
  const value = await statfs(storagePath, { bigint: true });
  return safeNumber(value.bavail * value.bsize, "Model Storage free-space result is too large.");
}

async function installedFilesPresent(files: InstalledModelFile[]): Promise<boolean> {
  for (const file of files) {
    try {
      const entry = await lstat(file.path);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== file.size) return false;
      if ((await sha256File(file.path)) !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function copyLocalSource(options: {
  acquisition: ModelAcquisition;
  selected: PlannedModelFile;
  sourcePath: string;
  stagedPath: string;
  state: ModelState;
  storagePath: string;
  dependencies: ModelImportDependencies;
}): Promise<void> {
  let existingBytes = 0;
  let stagedFileExists = false;
  try {
    const existing = await lstat(options.stagedPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(
        `Staged local model path is not a safe regular file: ${options.selected.fileName}`,
      );
    }
    stagedFileExists = true;
    existingBytes = existing.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existingBytes > options.selected.expectedSize) {
    throw new Error(`Staged local copy is larger than its exact confirmed source.`);
  }
  if (existingBytes > 0) {
    const [sourcePrefix, stagedPrefix] = await Promise.all([
      sha256Prefix(options.sourcePath, existingBytes),
      sha256Prefix(options.stagedPath, existingBytes),
    ]);
    if (sourcePrefix !== stagedPrefix) {
      throw new Error(
        `Staged local copy does not match the exact confirmed source prefix; uncertain bytes were not concatenated.`,
      );
    }
  }
  options.selected.receivedBytes = existingBytes;
  options.acquisition.status = "incomplete";
  options.acquisition.failure = null;
  await writeModelState(options.storagePath, options.state);
  const chunkBytes = options.dependencies.copyChunkBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("Local copy chunk size must be a positive integer.");
  }
  const source = await open(options.sourcePath, "r");
  const destination = await open(options.stagedPath, stagedFileExists ? "r+" : "wx");
  try {
    let position = existingBytes;
    while (position < options.selected.expectedSize) {
      const length = Math.min(chunkBytes, options.selected.expectedSize - position);
      const chunk = Buffer.allocUnsafe(length);
      const read = await source.read(chunk, 0, length, position);
      if (read.bytesRead !== length) {
        throw new Error(`Exact local source ended before its confirmed size.`);
      }
      const written = await destination.write(chunk, 0, length, position);
      if (written.bytesWritten !== length) throw new Error(`Local staging copy was incomplete.`);
      position += length;
      options.selected.receivedBytes = position;
      await writeModelState(options.storagePath, options.state);
      try {
        await options.dependencies.afterCopyChunk?.(position);
      } catch (error) {
        throw new LocalCopyInterruptedError(errorMessage(error));
      }
    }
    await destination.sync();
    await chmod(options.stagedPath, 0o600);
  } finally {
    await Promise.all([source.close(), destination.close()]);
  }
}

async function sha256Prefix(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  const digest = createHash("sha256");
  try {
    let position = 0;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, length)));
    while (position < length) {
      const wanted = Math.min(buffer.length, length - position);
      const read = await handle.read(buffer, 0, wanted, position);
      if (read.bytesRead !== wanted) throw new Error("Staged prefix is truncated.");
      digest.update(buffer.subarray(0, wanted));
      position += wanted;
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

class LocalCopyInterruptedError extends Error {
  constructor(cause: string) {
    super(`Local copy interrupted: ${cause}`);
  }
}

export async function withModelCatalogMutationLock<T>(
  storagePath: string,
  dependencies: ModelMutationDependencies,
  mutation: () => Promise<T>,
): Promise<T> {
  await assertManagedModelStorage(storagePath);
  const lockPath = join(storagePath, ".localhub-catalog", MUTATION_LOCK_NAME);
  const nonce = randomUUID();
  const claimPath = `${lockPath}.claim.${process.pid}.${nonce}`;
  const deadline = Date.now() + (dependencies.lockDeadlineMs ?? 300_000);
  const retryMs = dependencies.lockRetryMs ?? 25;
  if (!Number.isInteger(retryMs) || retryMs < 1) {
    throw new Error("Model catalog lock retry must be a positive integer.");
  }
  await mkdir(claimPath, { mode: 0o700 });
  try {
    await writeDurableFile(
      join(claimPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`,
    );
  } catch (error) {
    await rm(claimPath, { recursive: true, force: true });
    throw error;
  }
  let acquired = false;
  try {
    while (true) {
      try {
        await rename(claimPath, lockPath);
        acquired = true;
        break;
      } catch {
        if (!(await pathExists(lockPath))) continue;
        if (await reclaimDeadMutationLock(lockPath, dependencies.processAlive)) continue;
        if (Date.now() >= deadline) {
          throw new Error(
            "Model catalog is locked by another live mutation; no catalog or model bytes were changed.",
          );
        }
        await Bun.sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
    return await mutation();
  } finally {
    if (acquired) {
      const releasedPath = `${lockPath}.released.${process.pid}.${nonce}`;
      await rename(lockPath, releasedPath);
      await rm(releasedPath, { recursive: true, force: true });
    } else {
      await rm(claimPath, { recursive: true, force: true });
    }
  }
}

async function reclaimDeadMutationLock(
  lockPath: string,
  processAlive: ((pid: number) => boolean) | undefined,
): Promise<boolean> {
  try {
    const lockEntry = await lstat(lockPath);
    if (lockEntry.isSymbolicLink() || !lockEntry.isDirectory()) {
      throw new Error("Model catalog mutation lock is not a safe directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return !(await pathExists(lockPath));
    }
    throw new Error(`Model catalog mutation lock owner is unreadable: ${errorMessage(error)}`);
  }
  if (
    isRecord(owner) &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 1 &&
    typeof owner.nonce === "string"
  ) {
    if ((processAlive ?? isProcessAlive)(owner.pid as number)) return false;
  } else {
    throw new Error("Model catalog mutation lock owner is malformed; recovery stopped.");
  }
  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readModelStateForInspection(storagePath: string): Promise<ModelState> {
  if (!(await pathExists(promotionJournalPath(storagePath))))
    return await readModelState(storagePath);
  return await withModelCatalogMutationLock(
    storagePath,
    {},
    async () => await readReconciledModelState(storagePath),
  );
}

async function readReconciledModelState(storagePath: string): Promise<ModelState> {
  const state = await readModelState(storagePath);
  const journal = await readPromotionJournal(storagePath);
  if (!journal) return state;
  const acquisition = state.acquisitions.find((item) => item.id === journal.acquisitionId);
  if (!acquisition) {
    throw new Error("Model promotion journal names an unknown acquisition; recovery stopped.");
  }
  const finalDirectory = join(storagePath, ".localhub-models", journal.installed.id);
  const stagingPath = join(storagePath, ".localhub-staging", journal.acquisitionId);
  if (await safeManagedDirectoryExists(finalDirectory)) {
    if (!(await installedFilesPresent(journal.installed.files))) {
      throw new Error(
        "Model promotion journal final bytes do not match the verified manifest; recovery stopped.",
      );
    }
    const existing = state.installedModels.find((model) => model.id === journal.installed.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(journal.installed)) {
      throw new Error(
        "Model promotion journal conflicts with the installed catalog; recovery stopped.",
      );
    }
    if (
      !existing &&
      state.installedModels.some(
        (model) =>
          model.displayName.toLocaleLowerCase("en-US") ===
          journal.installed.displayName.toLocaleLowerCase("en-US"),
      )
    ) {
      throw new Error("Model promotion journal display name conflicts with the catalog.");
    }
    if (!existing) state.installedModels.push(journal.installed);
    acquisition.status = "installed";
    acquisition.installedModelId = journal.installed.id;
    acquisition.failure = null;
    await writeModelState(storagePath, state);
    await removePromotionJournal(storagePath);
    return state;
  }
  if (await safeManagedDirectoryExists(stagingPath)) {
    await removePromotionJournal(storagePath);
    return state;
  }
  throw new Error(
    "Model promotion journal has neither exact staging nor final bytes; recovery stopped.",
  );
}

async function readPromotionJournal(storagePath: string): Promise<PromotionJournal | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(promotionJournalPath(storagePath), "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.schema !== PROMOTION_SCHEMA ||
      typeof parsed.acquisitionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed.acquisitionId) ||
      !validInstalledModel(parsed.installed, storagePath)
    ) {
      throw new Error("Model promotion journal is incomplete or malformed.");
    }
    return parsed as unknown as PromotionJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePromotionJournal(
  storagePath: string,
  journal: PromotionJournal,
): Promise<void> {
  const path = promotionJournalPath(storagePath);
  if (await pathExists(path)) {
    throw new Error("A prior Model promotion requires recovery before another promotion.");
  }
  await writeAtomicFile(path, `${JSON.stringify(journal, null, 2)}\n`);
}

async function removePromotionJournal(storagePath: string): Promise<void> {
  await rm(promotionJournalPath(storagePath), { force: true });
}

function promotionJournalPath(storagePath: string): string {
  return join(storagePath, ".localhub-catalog", PROMOTION_JOURNAL_NAME);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function safeManagedDirectoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(
        `Managed Model Storage recovery path is not a safe directory: ${basename(path)}`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readModelState(storagePath: string): Promise<ModelState> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(storagePath, ".localhub-catalog", "models.json"), "utf8"),
    );
    if (!isRecord(parsed) || parsed.schema !== MODEL_STATE_SCHEMA) {
      throw new Error("Model catalog schema is unsupported or malformed.");
    }
    if (!validModelState(parsed, storagePath)) {
      throw new Error("Model catalog is incomplete or malformed.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: MODEL_STATE_SCHEMA, acquisitions: [], installedModels: [] };
    }
    throw error;
  }
}

function validModelState(value: unknown, storagePath: string): value is ModelState {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.acquisitions) || !Array.isArray(value.installedModels)) return false;
  if (!value.acquisitions.every((item) => validAcquisition(item, storagePath))) return false;
  if (!value.installedModels.every((item) => validInstalledModel(item, storagePath))) return false;
  const acquisitions = value.acquisitions as ModelAcquisition[];
  const installedModels = value.installedModels as InstalledModel[];
  if (new Set(acquisitions.map((item) => item.id)).size !== acquisitions.length) return false;
  if (new Set(installedModels.map((item) => item.id)).size !== installedModels.length) return false;
  if (
    new Set(installedModels.map((item) => item.displayName.toLocaleLowerCase("en-US"))).size !==
    installedModels.length
  ) {
    return false;
  }
  const installedIds = new Set(installedModels.map((item) => item.id));
  return acquisitions.every(
    (item) =>
      (item.status === "installed") === (item.installedModelId !== null) &&
      (item.installedModelId === null || installedIds.has(item.installedModelId)),
  );
}

function validAcquisition(value: unknown, storagePath: string): value is ModelAcquisition {
  if (!isRecord(value)) return false;
  const statuses = new Set(["planned", "incomplete", "failed", "installed", "discarded"]);
  return (
    typeof value.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id) &&
    typeof value.status === "string" &&
    statuses.has(value.status) &&
    typeof value.displayName === "string" &&
    value.displayName.trim().length > 0 &&
    value.storagePath === storagePath &&
    nonNegativeSafeInteger(value.requiredBytes) &&
    nonNegativeSafeInteger(value.availableBytes) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every(validPlannedFile) &&
    new Set(
      value.files.map((file) => (file as PlannedModelFile).fileName.toLocaleLowerCase("en-US")),
    ).size === value.files.length &&
    (value.installedModelId === null ||
      (typeof value.installedModelId === "string" &&
        /^[0-9a-f]{64}$/.test(value.installedModelId))) &&
    (value.failure === null || typeof value.failure === "string")
  );
}

function validPlannedFile(value: unknown): value is PlannedModelFile {
  if (!isRecord(value) || !isRecord(value.sourceIdentity)) return false;
  return (
    typeof value.sourcePath === "string" &&
    isAbsolute(value.sourcePath) &&
    typeof value.fileName === "string" &&
    value.fileName === basename(value.sourcePath) &&
    (value.role === "model" || value.role === "companion") &&
    (value.transfer === "adopt" || value.transfer === "copy") &&
    nonNegativeSafeInteger(value.expectedSize) &&
    nonNegativeSafeInteger(value.receivedBytes) &&
    value.receivedBytes <= value.expectedSize &&
    (value.publishedSha256 === null ||
      (typeof value.publishedSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(value.publishedSha256))) &&
    digitString(value.sourceIdentity.device) &&
    digitString(value.sourceIdentity.inode) &&
    digitString(value.sourceIdentity.modifiedNanoseconds) &&
    value.sourceIdentity.size === value.expectedSize
  );
}

function validInstalledModel(value: unknown, storagePath: string): value is InstalledModel {
  if (!isRecord(value) || !isRecord(value.quantization)) return false;
  const tensorTypes = value.quantization.tensorTypes;
  if (
    !isRecord(tensorTypes) ||
    !Object.values(tensorTypes).every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count > 0,
    )
  ) {
    return false;
  }
  if (!Array.isArray(value.files) || value.files.length === 0) return false;
  if (
    !value.files.every((file) => validInstalledFile(file, storagePath, String(value.id))) ||
    value.files.filter((file) => isRecord(file) && file.role === "model").length === 0 ||
    value.files.filter((file) => isRecord(file) && file.role === "companion").length > 1
  ) {
    return false;
  }
  const acquiredAt = typeof value.acquiredAt === "string" ? Date.parse(value.acquiredAt) : NaN;
  return (
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/.test(value.id) &&
    typeof value.displayName === "string" &&
    value.displayName.trim().length > 0 &&
    typeof value.available === "boolean" &&
    typeof value.architecture === "string" &&
    value.architecture.length > 0 &&
    nonNegativeSafeInteger(value.parameterCount) &&
    (value.quantization.fileType === null ||
      (typeof value.quantization.fileType === "number" &&
        Number.isFinite(value.quantization.fileType) &&
        value.quantization.fileType >= 0)) &&
    (value.trainingContext === null ||
      (typeof value.trainingContext === "number" &&
        Number.isFinite(value.trainingContext) &&
        value.trainingContext >= 0)) &&
    Array.isArray(value.templateHints) &&
    value.templateHints.every((hint) => typeof hint === "string") &&
    Number.isFinite(acquiredAt) &&
    new Date(acquiredAt).toISOString() === value.acquiredAt
  );
}

function validInstalledFile(value: unknown, storagePath: string, modelId: string): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.fileName !== "string" ||
    value.fileName.length === 0 ||
    value.fileName !== basename(value.fileName) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    (value.role !== "model" && value.role !== "companion") ||
    !nonNegativeSafeInteger(value.size) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.managed !== "boolean"
  ) {
    return false;
  }
  const expectedManagedPath = join(storagePath, ".localhub-models", modelId, value.fileName);
  if (
    value.managed ? value.path !== expectedManagedPath : !safeAdoptedPath(storagePath, value.path)
  ) {
    return false;
  }
  if (value.shard === null) return true;
  return (
    isRecord(value.shard) &&
    nonNegativeSafeInteger(value.shard.index) &&
    nonNegativeSafeInteger(value.shard.count) &&
    value.shard.count > 0 &&
    value.shard.index < value.shard.count
  );
}

function safeAdoptedPath(storagePath: string, path: string): boolean {
  if (!pathInside(storagePath, path)) return false;
  const first = relative(storagePath, path).split(/[\\/]/)[0] ?? "";
  return !MANAGED_DIRECTORIES.has(first);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function digitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

async function writeModelState(storagePath: string, state: ModelState): Promise<void> {
  const path = join(storagePath, ".localhub-catalog", "models.json");
  await writeAtomicFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeAtomicFile(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeDurableFile(temporaryPath, contents);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectGguf(path: string): Promise<GgufInspection> {
  const handle = await open(path, "r");
  try {
    const file = await handle.stat();
    const reader = new BinaryReader(handle, file.size);
    if ((await reader.bytes(4)).toString("ascii") !== "GGUF") {
      throw new Error(`Malformed GGUF ${basename(path)}: magic bytes are not GGUF.`);
    }
    const version = await reader.uint32();
    if (version !== 2 && version !== 3) {
      throw new Error(`Malformed GGUF ${basename(path)}: unsupported GGUF version ${version}.`);
    }
    const tensorCount = await reader.count("tensor count", 10_000_000);
    const metadataCount = await reader.count("metadata count", 1_000_000);
    const metadata = new Map<string, unknown>();
    for (let index = 0; index < metadataCount; index += 1) {
      const key = await reader.string(`metadata key ${index}`, 65_535);
      if (metadata.has(key))
        throw new Error(`Malformed GGUF ${basename(path)}: repeated key ${key}.`);
      const type = await reader.uint32();
      metadata.set(key, await reader.value(type, shouldKeepMetadata(key)));
    }
    const alignmentValue = metadata.get("general.alignment");
    const alignment =
      typeof alignmentValue === "number" && Number.isInteger(alignmentValue) ? alignmentValue : 32;
    if (alignment <= 0 || alignment > 1_048_576 || (alignment & (alignment - 1)) !== 0) {
      throw new Error(`Malformed GGUF ${basename(path)}: invalid tensor alignment.`);
    }
    const tensorTypes: Record<string, number> = {};
    let parameterCount = 0;
    let expectedTensorOffset = 0;
    for (let index = 0; index < tensorCount; index += 1) {
      await reader.string(`tensor name ${index}`, 65_535);
      const dimensions = await reader.uint32();
      if (dimensions === 0 || dimensions > 4) {
        throw new Error(
          `Malformed GGUF ${basename(path)}: tensor ${index} has invalid dimensions.`,
        );
      }
      const shape: number[] = [];
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        const size = await reader.count(`tensor ${index} dimension`, Number.MAX_SAFE_INTEGER);
        if (size === 0) {
          throw new Error(
            `Malformed GGUF ${basename(path)}: tensor ${index} has an empty dimension.`,
          );
        }
        shape.push(size);
      }
      const typeNumber = await reader.uint32();
      const tensorType = TENSOR_TYPES.get(typeNumber);
      if (!tensorType) {
        throw new Error(
          `Malformed or unsupported GGUF ${basename(path)}: tensor ${index} uses type ${typeNumber}.`,
        );
      }
      if ((shape[0] ?? 0) % tensorType.blockSize !== 0) {
        throw new Error(
          `Malformed GGUF ${basename(path)}: tensor ${index} row is not block-aligned.`,
        );
      }
      const offset = await reader.count(`tensor ${index} offset`, Number.MAX_SAFE_INTEGER);
      if (offset !== expectedTensorOffset) {
        throw new Error(
          `Malformed GGUF ${basename(path)}: tensor ${index} offset ${offset} did not match ${expectedTensorOffset}.`,
        );
      }
      const elements = shape.reduce((total, size) => safeProduct(total, size, path), 1);
      parameterCount = safeProduct(1, parameterCount + elements, path);
      const byteSize = safeProduct(elements / tensorType.blockSize, tensorType.typeSize, path);
      expectedTensorOffset = align(expectedTensorOffset + byteSize, alignment);
      tensorTypes[tensorType.name] = (tensorTypes[tensorType.name] ?? 0) + 1;
    }
    const dataOffset = align(reader.offset, alignment);
    if (dataOffset + expectedTensorOffset > file.size) {
      throw new Error(
        `Malformed GGUF ${basename(path)}: tensor data is truncated (${file.size} bytes).`,
      );
    }
    const architecture = metadata.get("general.architecture");
    if (typeof architecture !== "string" || !architecture) {
      throw new Error(`Malformed GGUF ${basename(path)}: general.architecture is missing.`);
    }
    const context = metadata.get(`${architecture}.context_length`);
    const template = metadata.get("tokenizer.chat_template");
    return {
      architecture,
      name: stringMetadata(metadata.get("general.name")),
      parameterCount,
      tensorCount,
      fileType: numberMetadata(metadata.get("general.file_type")),
      tensorTypes,
      trainingContext: numberMetadata(context),
      templateHints:
        typeof template === "string"
          ? [template]
          : Array.isArray(template)
            ? template.filter((item): item is string => typeof item === "string")
            : [],
      projectorTypes: [
        metadata.get("clip.projector_type"),
        metadata.get("clip.vision.projector_type"),
        metadata.get("clip.audio.projector_type"),
      ].filter((value): value is string => typeof value === "string" && value.length > 0),
      split: splitMetadata(metadata, tensorCount, path),
    };
  } finally {
    await handle.close();
  }
}

class BinaryReader {
  offset = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly fileSize: number,
  ) {}

  async bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.fileSize) {
      throw new Error("Malformed GGUF: unexpected end of file.");
    }
    const value = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(value, 0, length, this.offset);
    if (bytesRead !== length) throw new Error("Malformed GGUF: unexpected end of file.");
    this.offset += length;
    return value;
  }

  async uint32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE();
  }

  async count(label: string, maximum: number): Promise<number> {
    const value = (await this.bytes(8)).readBigUInt64LE();
    if (value > BigInt(maximum)) throw new Error(`Malformed GGUF: ${label} is too large.`);
    return Number(value);
  }

  async string(label: string, maximum: number): Promise<string> {
    const length = await this.count(`${label} length`, maximum);
    return (await this.bytes(length)).toString("utf8");
  }

  async value(type: number, keep: boolean): Promise<unknown> {
    const sizes = new Map([
      [0, 1],
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 4],
      [5, 4],
      [6, 4],
      [7, 1],
      [10, 8],
      [11, 8],
      [12, 8],
    ]);
    if (type === 8)
      return keep ? await this.string("string value", 268_435_456) : await this.skipString();
    if (type === 9) {
      const elementType = await this.uint32();
      if (elementType === 9 || elementType > 12)
        throw new Error("Malformed GGUF: invalid array type.");
      const count = await this.count("array count", 100_000_000);
      const values: unknown[] = [];
      for (let index = 0; index < count; index += 1) {
        const value = await this.value(elementType, keep);
        if (keep) values.push(value);
      }
      return keep ? values : null;
    }
    const size = sizes.get(type);
    if (!size) throw new Error(`Malformed GGUF: invalid metadata type ${type}.`);
    const bytes = await this.bytes(size);
    if (!keep) return null;
    switch (type) {
      case 0:
        return bytes.readUInt8();
      case 1:
        return bytes.readInt8();
      case 2:
        return bytes.readUInt16LE();
      case 3:
        return bytes.readInt16LE();
      case 4:
        return bytes.readUInt32LE();
      case 5:
        return bytes.readInt32LE();
      case 6:
        return bytes.readFloatLE();
      case 7:
        return bytes.readUInt8() === 1;
      case 10: {
        const value = bytes.readBigUInt64LE();
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
      }
      case 11: {
        const value = bytes.readBigInt64LE();
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value.toString();
      }
      case 12:
        return bytes.readDoubleLE();
      default:
        return null;
    }
  }

  private async skipString(): Promise<null> {
    const length = await this.count("string value length", 268_435_456);
    await this.bytes(length);
    return null;
  }
}

function shouldKeepMetadata(key: string): boolean {
  return (
    key === "general.architecture" ||
    key === "general.name" ||
    key === "general.file_type" ||
    key === "general.alignment" ||
    key === "tokenizer.chat_template" ||
    key === "clip.projector_type" ||
    key === "clip.vision.projector_type" ||
    key === "clip.audio.projector_type" ||
    key === "split.no" ||
    key === "split.count" ||
    key === "split.tensors.count" ||
    key.endsWith(".context_length")
  );
}

function orderAndVerifyModelFiles<T extends { fileName: string; inspection: GgufInspection }>(
  files: T[],
): T[] {
  if (files.length === 0) throw new Error("Select one exact model GGUF or complete shard set.");
  if (files.length === 1 && files[0]?.inspection.split === null) return files;
  const ordered = [...files].sort(
    (left, right) =>
      (left.inspection.split?.index ?? Number.MAX_SAFE_INTEGER) -
      (right.inspection.split?.index ?? Number.MAX_SAFE_INTEGER),
  );
  const expectedCount = ordered[0]?.inspection.split?.count;
  const expectedTensorCount = ordered[0]?.inspection.split?.tensorCount;
  if (!expectedCount || expectedCount !== ordered.length || expectedTensorCount === undefined) {
    throw new Error(
      `Missing GGUF shard: selected ${ordered.length} files but embedded split.count requires ${String(expectedCount ?? "an exact complete set")}.`,
    );
  }
  const architecture = ordered[0]?.inspection.architecture;
  const modelName = ordered[0]?.inspection.name;
  let observedTensors = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const file = ordered[index];
    const split = file?.inspection.split;
    const filename = file?.fileName.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
    if (
      !file ||
      !split ||
      split.index !== index ||
      split.count !== expectedCount ||
      split.tensorCount !== expectedTensorCount ||
      file.inspection.architecture !== architecture ||
      file.inspection.name !== modelName ||
      !filename ||
      Number(filename[1]) !== index + 1 ||
      Number(filename[2]) !== expectedCount
    ) {
      throw new Error(
        `Mismatched GGUF shard ${file?.fileName ?? String(index)}; no substitute was selected.`,
      );
    }
    observedTensors += file.inspection.tensorCount;
  }
  if (observedTensors !== expectedTensorCount) {
    throw new Error(
      `Incomplete GGUF shard tensor manifest: expected ${expectedTensorCount}, observed ${observedTensors}.`,
    );
  }
  return ordered;
}

function mergeTensorTypes(values: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    for (const [name, count] of Object.entries(value)) result[name] = (result[name] ?? 0) + count;
  }
  return result;
}

function splitMetadata(
  metadata: Map<string, unknown>,
  tensorCount: number,
  path: string,
): GgufInspection["split"] {
  const index = numberMetadata(metadata.get("split.no"));
  const count = numberMetadata(metadata.get("split.count"));
  const splitTensorCount = numberMetadata(metadata.get("split.tensors.count"));
  if (index === null && count === null && splitTensorCount === null) return null;
  if (
    index === null ||
    count === null ||
    splitTensorCount === null ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    !Number.isInteger(splitTensorCount) ||
    index < 0 ||
    count < 1 ||
    index >= count ||
    splitTensorCount < tensorCount
  ) {
    throw new Error(`Malformed GGUF ${basename(path)}: split metadata is incomplete or invalid.`);
  }
  return { index, count, tensorCount: splitTensorCount };
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pathInside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (!difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(difference))
  );
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function safeProduct(left: number, right: number, path: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result))
    throw new Error(`Malformed GGUF ${basename(path)}: tensor size is too large.`);
  return result;
}

function safeNumber(value: bigint, message: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(message);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
