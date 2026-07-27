import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runLifecycleSmoke, type AcceptanceDependencies } from "../src/acceptance.ts";
import { validateEvidenceRecord, type EvidenceEnvironment } from "../src/evidence.ts";
import { verifyReleaseCandidate } from "../src/release.ts";

const candidateRecordPath = Bun.argv[2];
const evidencePath = Bun.argv[3];
if (!candidateRecordPath || !evidencePath) {
  console.error(
    "Usage: bun run scripts/run-lifecycle-smoke.ts <release-candidate.json> <evidence.json>",
  );
  process.exit(2);
}

const candidateJson = (await Bun.file(candidateRecordPath).json()) as {
  asset?: { path?: unknown };
};
if (typeof candidateJson.asset?.path !== "string") {
  console.error("Candidate record does not declare an asset path.");
  process.exit(2);
}
const absoluteCandidatePath = resolve(candidateRecordPath);
const executablePath = resolve(dirname(absoluteCandidatePath), candidateJson.asset.path);
const buildCommit = await command([executablePath, "release", "build-commit"]);
const candidate = await verifyReleaseCandidate(absoluteCandidatePath, executablePath, {
  buildCommit,
});
const stateDirectory = join(dirname(dirname(resolve(evidencePath))), "run-state", "t02-lifecycle");
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

const dependencies: AcceptanceDependencies = {
  process: {
    run: async (commandLine) => {
      const child = Bun.spawn(commandLine, {
        env: { ...process.env, LOCALHUB_RUN_STATE_DIR: stateDirectory },
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
const record = await runLifecycleSmoke(
  {
    candidate,
    candidateRecordPath: absoluteCandidatePath,
    executablePath,
    evidenceId: `t02-lifecycle-${candidate.manifest.release.commit.slice(0, 12)}`,
    environment: await collectEnvironment(),
    seam: "assembled-release",
    artifactLinks: [
      `https://github.com/scwlkr/LocalHub/commit/${candidate.manifest.release.commit}`,
      "https://github.com/scwlkr/LocalHub/issues/22",
    ],
  },
  dependencies,
);
validateEvidenceRecord(record, candidate);
await mkdir(dirname(resolve(evidencePath)), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
console.log(`Lifecycle evidence written: ${resolve(evidencePath)}`);
if (record.gates.some((gate) => gate.status !== "Passed")) process.exit(1);

async function collectEnvironment(): Promise<EvidenceEnvironment> {
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
    networkLane: "macOS arm64 loopback lifecycle",
    modelVariantHashes: [],
    companionHashes: [],
    chatTemplate: null,
    runProfileRevision: null,
    effectiveSettings:
      "llama.cpp b10107 empty router; autoload, automatic fit, Web UI, built-in agent/tools, and MCP proxy disabled; no model or Run Profile claimed",
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
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${commandLine[0]} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}
