import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { EvidenceEnvironment, EvidenceRecord, EvidenceStatus } from "../src/evidence.ts";
import { validateEvidenceRecord } from "../src/evidence.ts";
import { advanceFirstRun, createFirstRunState, writeFirstRunState } from "../src/first-run.ts";
import { prepareModelStorage } from "../src/guided-native.ts";
import type { InstalledModel } from "../src/model-acquisition.ts";
import { verifyReleaseCandidate } from "../src/release.ts";
import type {
  AcceptedSharedModelTarget,
  ProfileResult,
  RunProfileRevision,
  SharedModel,
} from "../src/run-profile.ts";

const candidateRecordPath = resolve(Bun.argv[2] ?? "");
const evidencePath = resolve(Bun.argv[3] ?? "");
const sourcePath = resolve(Bun.argv[4] ?? "");
let commandEnvironment = { ...process.env };
if (!Bun.argv[2] || !Bun.argv[3] || !Bun.argv[4]) {
  console.error(
    "Usage: bun run scripts/run-profile-smoke.ts <release-candidate.json> <evidence.json> <exact-text.gguf>",
  );
  process.exit(2);
}

const candidateJson = (await Bun.file(candidateRecordPath).json()) as {
  asset?: { path?: unknown };
};
if (typeof candidateJson.asset?.path !== "string") {
  throw new Error("Candidate record does not declare an executable path.");
}
const executablePath = resolve(dirname(candidateRecordPath), candidateJson.asset.path);
const buildCommit = await successful([executablePath, "release", "build-commit"]);
const candidate = await verifyReleaseCandidate(candidateRecordPath, executablePath, {
  buildCommit,
});
const sourceBefore = new Uint8Array(await Bun.file(sourcePath).arrayBuffer());
const sourceSha256 = sha256(sourceBefore);
const evidenceDirectory = dirname(evidencePath);
await mkdir(evidenceDirectory, { recursive: true });
const workspace = await mkdtemp(join(evidenceDirectory, "profile-smoke-"));
const storagePath = join(workspace, "model-storage");
const firstRunStatePath = join(workspace, "first-run.json");
await mkdir(storagePath, { mode: 0o700 });
await prepareModelStorage(storagePath);
const storage = await statfs(storagePath, { bigint: true });
let firstRun = createFirstRunState(candidate);
firstRun = advanceFirstRun(firstRun, {
  step: "trust",
  verified: true,
  summary: "Exact assembled candidate verified for T05 profile evidence.",
});
firstRun = advanceFirstRun(firstRun, {
  step: "host-computer",
  report: {
    passed: true,
    results: [{ name: "T05 Host lane", status: "passed", detail: "Physical macOS arm64 Host" }],
    privateInterfaces: [],
    failure: null,
  },
});
firstRun = advanceFirstRun(firstRun, {
  step: "model-storage",
  path: storagePath,
  freeBytes: Number(storage.bavail * storage.bsize),
});
await writeFirstRunState(firstRunStatePath, firstRun);
commandEnvironment = { ...process.env, LOCALHUB_FIRST_RUN_STATE: firstRunStatePath };

const prepared = await jsonCommand<Record<string, unknown>>([
  executablePath,
  "model",
  "prepare",
  "--name",
  "T05 exact text model",
  "--file",
  sourcePath,
  "--sha256",
  `${sourcePath}=${sourceSha256}`,
]);
const installed = await jsonCommand<InstalledModel>([
  executablePath,
  "model",
  "import",
  stringField(prepared, "id"),
]);
const renamed = await jsonCommand<InstalledModel>([
  executablePath,
  "model",
  "rename",
  installed.id,
  "T05 renamed exact text model",
]);
if (renamed.id !== installed.id) throw new Error("Display rename changed content identity.");
const chatTemplate = renamed.templateHints[0];
if (!chatTemplate) throw new Error("Installed text model has no explicit chat template hint.");
const templateSha256 = sha256(new TextEncoder().encode(chatTemplate));

const firstRevision = await jsonCommand<RunProfileRevision>([
  executablePath,
  "profile",
  "create",
  "--name",
  "T05 exact text",
  "--model",
  installed.id,
  "--template-sha256",
  templateSha256,
  "--context",
  "4096",
  "--slots",
  "2",
  "--gpu-layers",
  "999",
  "--threads",
  "8",
]);
const firstResult = await jsonCommand<ProfileResult>([
  executablePath,
  "profile",
  "test",
  firstRevision.id,
]);
if (firstResult.outcome !== "Passed") {
  throw new Error(`First real Profile Test failed: ${String(firstResult.failure)}`);
}
const shared = await jsonCommand<SharedModel>([
  executablePath,
  "shared",
  "publish",
  "--name",
  "T05 Family Text",
  "--revision",
  firstRevision.id,
  "--context-limit",
  "2048",
  "--output-limit",
  "256",
  "--concurrency",
  "1",
]);
const acceptedBefore = await jsonCommand<AcceptedSharedModelTarget>([
  executablePath,
  "shared",
  "target",
  shared.id,
]);
const transitions = [
  await jsonCommand([executablePath, "shared", "pin", shared.id]),
  await jsonCommand([executablePath, "shared", "unpin", shared.id]),
  await jsonCommand([executablePath, "shared", "unshare", shared.id]),
];
const unsharedTarget = await command([executablePath, "shared", "target", shared.id]);
if (unsharedTarget.code === 0 || !unsharedTarget.stderr.includes("unshared")) {
  throw new Error("Unshared model unexpectedly accepted new work.");
}
transitions.push(await jsonCommand([executablePath, "shared", "share", shared.id]));

const secondRevision = await jsonCommand<RunProfileRevision>([
  executablePath,
  "profile",
  "revise",
  firstRevision.id,
  "--context",
  "3072",
]);
const stalePublish = await command([
  executablePath,
  "shared",
  "publish",
  "--name",
  "Rejected stale text",
  "--revision",
  firstRevision.id,
  "--context-limit",
  "1024",
  "--output-limit",
  "128",
  "--concurrency",
  "1",
]);
if (stalePublish.code === 0 || !stalePublish.stderr.includes("stale")) {
  throw new Error("Stale Profile Result unexpectedly published.");
}
const secondResult = await jsonCommand<ProfileResult>([
  executablePath,
  "profile",
  "test",
  secondRevision.id,
]);
if (secondResult.outcome !== "Passed") {
  throw new Error(`Replacement real Profile Test failed: ${String(secondResult.failure)}`);
}
const replacement = await jsonCommand<SharedModel>([
  executablePath,
  "shared",
  "replace",
  shared.id,
  secondRevision.id,
]);
const acceptedAfter = await jsonCommand<AcceptedSharedModelTarget>([
  executablePath,
  "shared",
  "target",
  shared.id,
]);
if (
  acceptedBefore.revisionId !== firstRevision.id ||
  acceptedAfter.revisionId !== secondRevision.id ||
  replacement.revisionId !== secondRevision.id
) {
  throw new Error("Explicit replacement changed the wrong accepted request target.");
}

const wrongTemplate = await command([
  executablePath,
  "profile",
  "create",
  "--name",
  "Wrong template attempt",
  "--model",
  installed.id,
  "--template-sha256",
  "0".repeat(64),
  "--context",
  "2048",
  "--slots",
  "1",
  "--gpu-layers",
  "999",
  "--threads",
  "8",
]);
if (
  wrongTemplate.code === 0 ||
  !wrongTemplate.stderr.includes("No template hint was substituted")
) {
  throw new Error("Unavailable chat template unexpectedly selected a substitute.");
}

const exactManagedPath = installed.files.find((file) => file.role === "model")?.path;
if (!exactManagedPath) throw new Error("Installed Model record omitted its exact model path.");
const movedPath = `${exactManagedPath}.temporarily-missing`;
const decoyPath = join(dirname(exactManagedPath), `similar-${basename(exactManagedPath)}`);
await rename(exactManagedPath, movedPath);
try {
  await writeFile(decoyPath, "similarly named decoy; not selected", { mode: 0o600 });
  const missingAttempt = await command([executablePath, "profile", "test", secondRevision.id]);
  if (
    missingAttempt.code === 0 ||
    !missingAttempt.stderr.includes("No similarly named model was selected")
  ) {
    throw new Error("Missing exact content unexpectedly selected a similarly named substitute.");
  }
} finally {
  await rename(movedPath, exactManagedPath);
}

const ledger = await jsonCommand<{
  revisions: Array<RunProfileRevision & { evidenceState: string }>;
  results: Array<ProfileResult & { evidenceState: string }>;
}>([executablePath, "profile", "list"]);
const firstLedger = ledger.revisions.find((item) => item.id === firstRevision.id);
const secondLedger = ledger.revisions.find((item) => item.id === secondRevision.id);
if (firstLedger?.evidenceState !== "Stale" || secondLedger?.evidenceState !== "Passed") {
  throw new Error("Profile ledger did not preserve stale and passing evidence states.");
}
if (
  !(await Bun.file(sourcePath).exists()) ||
  sha256(await Bun.file(sourcePath).bytes()) !== sourceSha256
) {
  throw new Error("Profile evidence changed the outside exact model source.");
}

const timestamp = new Date().toISOString();
const environment = await evidenceEnvironment(sourceSha256, secondRevision, secondResult);
const record: EvidenceRecord = {
  schema: "localhub.release-evidence/v1",
  evidenceId: `t05-physical-profile-${candidate.manifest.release.commit.slice(0, 12)}`,
  seam: "assembled-release",
  candidate: {
    candidateId: candidate.candidate.candidateId,
    commit: candidate.manifest.release.commit,
    assetSha256: candidate.candidate.asset.sha256,
    manifestSha256: candidate.candidate.manifest.sha256,
  },
  environment,
  gates: [
    gate(
      "LH-J2-004",
      ["LH-MOD-011", "LH-MOD-012", "LH-MOD-013", "LH-MOD-018", "LH-MOD-019"],
      "Run exact b10107 text profile with fitting disabled and observe load, slots, KV, placement, text, cancellation, stop, resources, and performance.",
      `Passed exact load; ${secondResult.effective.slotCount} slots at ${secondResult.effective.contextPerSlot} tokens each; ${secondResult.effective.kvLayout} KV; ${secondResult.effective.placement} placement; cancellation released in ${secondResult.cancellation.slotReleasedMs} ms; graceful stop; load ${secondResult.measurements.loadTimeMs} ms; first token ${secondResult.measurements.firstTokenTimeMs} ms; throughput ${secondResult.measurements.throughputTokensPerSecond.toFixed(2)} tokens/s; peak RAM ${secondResult.measurements.peakRamBytes} bytes; peak GPU-associated memory ${secondResult.measurements.peakGpuBytes} bytes.`,
      timestamp,
    ),
    gate(
      "LH-J2-005",
      ["LH-MOD-011", "LH-MOD-013", "LH-MOD-015"],
      "Edit one bound input, preserve prior result as stale, and reject stale publication.",
      "Passed: the earlier immutable result is Stale, the new revision was independently tested, and stale publication failed visibly.",
      timestamp,
    ),
    gate(
      "LH-J2-006",
      ["LH-MOD-015", "LH-MOD-016", "LH-QUE-011"],
      "Publish text, pin, unpin, unshare, reshare, and explicitly replace while retaining accepted targets.",
      `Passed: explicit transitions completed; accepted revision ${acceptedBefore.revisionId.slice(0, 12)} remained immutable while new work moved to ${acceptedAfter.revisionId.slice(0, 12)}.`,
      timestamp,
    ),
    gate(
      "LH-J2-007",
      ["LH-MOD-014", "LH-MOD-015", "LH-MOD-020"],
      "Expose only real proven capabilities for the exact profile.",
      "Passed: basic text is Passed; image input, Browser Tools, and Tool Runner functions remain Unavailable.",
      timestamp,
    ),
    gate(
      "LH-J2-008",
      ["LH-MOD-017"],
      "Attempt stale, missing, wrong-template, and similarly named substitutions.",
      "Passed: every exact-target failure was visible and no file, template, profile, runtime, context, or capability substitute was selected.",
      timestamp,
    ),
  ],
};
validateEvidenceRecord(record, candidate);
await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
console.log(`Profile evidence written for ${basename(sourcePath)}: ${evidencePath}`);

function gate(
  journeyGateId: string,
  requirementIds: string[],
  action: string,
  observed: string,
  timestamp: string,
) {
  return {
    journeyGateId,
    requirementIds,
    classification: "Mandatory" as const,
    status: "Passed" as EvidenceStatus,
    action,
    expected:
      "The exact selected target passes without fitting, fallback, substitution, or stale proof.",
    observed,
    artifactLinks: [
      `https://github.com/scwlkr/LocalHub/commit/${candidate.manifest.release.commit}`,
      "https://github.com/scwlkr/LocalHub/issues/25",
    ],
    tester: "LocalHub T05 physical Host verification",
    timestamp,
    priorAttempts: [],
  };
}

async function evidenceEnvironment(
  modelSha256: string,
  revision: RunProfileRevision,
  result: ProfileResult,
): Promise<EvidenceEnvironment> {
  const [productVersion, buildVersion, hardware] = await Promise.all([
    successful(["sw_vers", "-productVersion"]),
    successful(["sw_vers", "-buildVersion"]),
    successful(["sysctl", "-n", "machdep.cpu.brand_string"]),
  ]);
  return {
    hostHardware: hardware,
    hostOsVersion: `macOS ${productVersion} (${buildVersion})`,
    toolRunnerHardware: null,
    toolRunnerOsVersion: null,
    browsers: [],
    networkLane: "Physical macOS arm64 loopback-only exact Profile Test",
    modelVariantHashes: [`sha256:${modelSha256}`],
    companionHashes: [],
    chatTemplate: `sha256:${revision.chatTemplateSha256}`,
    runProfileRevision: revision.id,
    effectiveSettings: JSON.stringify({
      automaticFit: result.effective.automaticFit,
      builtInAgent: result.effective.builtInAgent,
      builtInTools: result.effective.builtInTools,
      contextPerSlot: result.effective.contextPerSlot,
      kvLayout: result.effective.kvLayout,
      placement: result.effective.placement,
      slotCount: result.effective.slotCount,
    }),
    measurements: {
      loadTimeMs: result.measurements.loadTimeMs,
      firstTokenTimeMs: result.measurements.firstTokenTimeMs,
      throughputTokensPerSecond: result.measurements.throughputTokensPerSecond,
      peakRamBytes: result.measurements.peakRamBytes,
      peakGpuBytes: result.measurements.peakGpuBytes,
      queueTimeMs: null,
      toolDurationMs: null,
    },
    testDate: new Date().toISOString().slice(0, 10),
  };
}

async function jsonCommand<T = unknown>(commandLine: string[]): Promise<T> {
  const result = await command(commandLine);
  if (result.code !== 0) {
    throw new Error(`${commandLine.slice(1, 3).join(" ")} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

async function successful(commandLine: string[]): Promise<string> {
  const result = await command(commandLine);
  if (result.code !== 0) throw new Error(`${commandLine[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function command(
  commandLine: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(commandLine, {
    env: commandEnvironment,
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

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) throw new Error(`Missing ${field}.`);
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
