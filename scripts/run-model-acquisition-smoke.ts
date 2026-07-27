import { createHash } from "node:crypto";
import { mkdir, mkdtemp, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type AcceptanceDependencies, runModelAcquisitionSmoke } from "../src/acceptance.ts";
import { type EvidenceEnvironment, validateEvidenceRecord } from "../src/evidence.ts";
import { advanceFirstRun, createFirstRunState, writeFirstRunState } from "../src/first-run.ts";
import { prepareModelStorage } from "../src/guided-native.ts";
import { verifyReleaseCandidate } from "../src/release.ts";

const candidateRecordPath = Bun.argv[2];
const evidencePath = Bun.argv[3];
const selectedSourcePath = Bun.argv[4];
if (!candidateRecordPath || !evidencePath) {
  console.error(
    "Usage: bun run scripts/run-model-acquisition-smoke.ts <release-candidate.json> <evidence.json> [exact-local.gguf]",
  );
  process.exit(2);
}

const absoluteCandidatePath = resolve(candidateRecordPath);
const candidateJson = (await Bun.file(absoluteCandidatePath).json()) as {
  asset?: { path?: unknown };
};
if (typeof candidateJson.asset?.path !== "string") {
  console.error("Candidate record does not declare an asset path.");
  process.exit(2);
}
const executablePath = resolve(dirname(absoluteCandidatePath), candidateJson.asset.path);
const buildCommit = await command([executablePath, "release", "build-commit"]);
const candidate = await verifyReleaseCandidate(absoluteCandidatePath, executablePath, {
  buildCommit,
});

const evidenceDirectory = dirname(resolve(evidencePath));
await mkdir(evidenceDirectory, { recursive: true });
const workspace = await mkdtemp(join(dirname(evidenceDirectory), "model-acquisition-"));
const modelStoragePath = join(workspace, "model-storage");
const firstRunStatePath = join(workspace, "first-run.json");
const runStateDirectory = join(workspace, "run-state");
await mkdir(modelStoragePath, { mode: 0o700 });
await prepareModelStorage(modelStoragePath);
const sourcePath = selectedSourcePath
  ? resolve(selectedSourcePath)
  : join(workspace, "deterministic-q4_k.gguf");
if (!selectedSourcePath) await writeFile(sourcePath, deterministicGguf(), { mode: 0o600 });
const sourceBytes = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const physicalLocalSource = selectedSourcePath !== undefined;

const storage = await statfs(modelStoragePath, { bigint: true });
let firstRun = createFirstRunState(candidate);
firstRun = advanceFirstRun(firstRun, {
  step: "trust",
  verified: true,
  summary: "Exact assembled candidate identity verified for local acquisition evidence.",
});
firstRun = advanceFirstRun(firstRun, {
  step: "host-computer",
  report: {
    passed: true,
    results: [
      {
        name: "Candidate evidence lane",
        status: "passed",
        detail: "macOS arm64 local acquisition boundary",
      },
    ],
    privateInterfaces: [],
    failure: null,
  },
});
firstRun = advanceFirstRun(firstRun, {
  step: "model-storage",
  path: modelStoragePath,
  freeBytes: Number(storage.bavail * storage.bsize),
});
await writeFirstRunState(firstRunStatePath, firstRun);

const dependencies: AcceptanceDependencies = {
  process: {
    run: async (commandLine) => {
      const child = Bun.spawn(commandLine, {
        env: {
          ...process.env,
          LOCALHUB_FIRST_RUN_STATE: firstRunStatePath,
          LOCALHUB_RUN_STATE_DIR: runStateDirectory,
        },
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
    },
  },
  clock: { now: () => new Date() },
  storage: { read: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()) },
  network: { fetch },
  llamaCpp: { origin: "assembled-candidate-loopback-worker" },
  responses: { origin: "not-enabled-without-a-tested-model-profile" },
  failure: { activate: async () => undefined },
};
const record = await runModelAcquisitionSmoke(
  {
    candidate,
    candidateRecordPath: absoluteCandidatePath,
    executablePath,
    evidenceId: `t04-${physicalLocalSource ? "physical" : "deterministic"}-local-model-${candidate.manifest.release.commit.slice(0, 12)}`,
    environment: await collectEnvironment(sourceSha256, physicalLocalSource),
    seam: "assembled-release",
    artifactLinks: [
      `https://github.com/scwlkr/LocalHub/commit/${candidate.manifest.release.commit}`,
      "https://github.com/scwlkr/LocalHub/issues/24",
    ],
    modelSourcePath: sourcePath,
    modelSourceSha256: sourceSha256,
  },
  dependencies,
);
validateEvidenceRecord(record, candidate);
await writeFile(resolve(evidencePath), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
console.log(
  `Model acquisition evidence written for ${basename(sourcePath)}: ${resolve(evidencePath)}`,
);
if (record.gates.some((gate) => gate.status !== "Passed")) process.exit(1);

async function collectEnvironment(
  sourceSha256: string,
  physicalLocalSource: boolean,
): Promise<EvidenceEnvironment> {
  const [productVersion, buildVersion, hardware] = await Promise.all([
    command(["sw_vers", "-productVersion"]),
    command(["sw_vers", "-buildVersion"]),
    command(["sysctl", "-n", "machdep.cpu.brand_string"]),
  ]);
  return {
    hostHardware: hardware,
    hostOsVersion: `macOS ${productVersion} (${buildVersion})`,
    toolRunnerHardware: null,
    toolRunnerOsVersion: null,
    browsers: [],
    networkLane: physicalLocalSource
      ? "Physical macOS arm64 local GGUF acquisition"
      : "macOS arm64 assembled candidate deterministic GGUF acquisition",
    modelVariantHashes: [`sha256:${sourceSha256}`],
    companionHashes: [],
    chatTemplate: null,
    runProfileRevision: null,
    effectiveSettings:
      "Exact local-file copy, offline verification, atomic promotion, and loopback Host inventory; no model load, Profile Test, share, remote source, or inference claimed",
    measurements: {
      loadTimeMs: null,
      firstTokenTimeMs: null,
      throughputTokensPerSecond: null,
      peakRamBytes: null,
      peakGpuBytes: null,
      queueTimeMs: null,
      toolDurationMs: null,
    },
    testDate: new Date().toISOString().slice(0, 10),
  };
}

async function command(commandLine: string[]): Promise<string> {
  const child = Bun.spawn(commandLine, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${commandLine[0]} failed while collecting local acquisition evidence.`);
  }
  return stdout.trim();
}

function deterministicGguf(): Buffer {
  const metadata = [
    kvString("general.architecture", "qwen2"),
    kvString("general.name", "Deterministic Q4_K"),
    kvUint32("general.file_type", 12),
    kvUint32("qwen2.context_length", 4096),
    kvString("tokenizer.chat_template", "{{ messages }}"),
  ];
  const tensor = Buffer.concat([
    ggufString("weight"),
    uint32(1),
    uint64(256),
    uint32(12),
    uint64(0),
  ]);
  const header = Buffer.concat([
    Buffer.from("GGUF"),
    uint32(3),
    uint64(1),
    uint64(metadata.length),
    ...metadata,
    tensor,
  ]);
  const padding = Buffer.alloc((32 - (header.length % 32)) % 32);
  return Buffer.concat([header, padding, Buffer.alloc(160, 7)]);
}

function kvString(key: string, value: string): Buffer {
  return Buffer.concat([ggufString(key), uint32(8), ggufString(value)]);
}

function kvUint32(key: string, value: number): Buffer {
  return Buffer.concat([ggufString(key), uint32(4), uint32(value)]);
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([uint64(bytes.length), bytes]);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function uint64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}
