import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runCandidateSmoke, type AcceptanceDependencies } from "../src/acceptance.ts";
import {
  validateEvidenceRecord,
  type EvidenceEnvironment,
  type EvidenceSeam,
} from "../src/evidence.ts";
import { verifyReleaseCandidate } from "../src/release.ts";

const candidateRecordPath = Bun.argv[2];
const evidencePath = Bun.argv[3];
const seam = (Bun.argv[4] ?? "assembled-release") as EvidenceSeam;
if (!candidateRecordPath || !evidencePath) {
  console.error(
    "Usage: bun run scripts/run-candidate-smoke.ts <release-candidate.json> <evidence.json> [assembled-release|controlled-external-dependency]",
  );
  process.exit(2);
}
if (seam !== "assembled-release" && seam !== "controlled-external-dependency") {
  console.error("Evidence seam must be assembled-release or controlled-external-dependency.");
  process.exit(2);
}

const candidateJson = (await Bun.file(candidateRecordPath).json()) as {
  asset?: { path?: unknown };
};
if (typeof candidateJson.asset?.path !== "string") {
  console.error("Candidate record does not declare an asset path.");
  process.exit(2);
}
const executablePath = resolve(dirname(candidateRecordPath), candidateJson.asset.path);
const buildCommit = await command([executablePath, "release", "build-commit"]);
const candidate = await verifyReleaseCandidate(candidateRecordPath, executablePath, {
  buildCommit,
});
const environment = await collectEnvironment(seam);
const dependencies: AcceptanceDependencies = {
  process: {
    run: async (command) => {
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
  llamaCpp: { origin: "not-supplied-by-t01" },
  responses: { origin: "not-supplied-by-t01" },
  failure: { activate: async () => undefined },
};
const record = await runCandidateSmoke(
  {
    candidate,
    candidateRecordPath,
    executablePath,
    evidenceId: `t01-${seam}-${candidate.manifest.release.commit.slice(0, 12)}`,
    environment,
    seam,
    artifactLinks: [
      `https://github.com/scwlkr/LocalHub/commit/${candidate.manifest.release.commit}`,
    ],
  },
  dependencies,
);
validateEvidenceRecord(record, candidate);
await mkdir(dirname(resolve(evidencePath)), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
console.log(`Evidence written: ${resolve(evidencePath)}`);

async function collectEnvironment(seam: EvidenceSeam): Promise<EvidenceEnvironment> {
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
    networkLane:
      seam === "assembled-release"
        ? "macOS arm64 assembled candidate smoke"
        : "Controlled external dependency seam",
    modelVariantHashes: [],
    companionHashes: [],
    chatTemplate: null,
    runProfileRevision: null,
    effectiveSettings: null,
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
  const child = Bun.spawn(commandLine, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) {
    throw new Error(`${commandLine[0]} failed while collecting sanitized environment evidence.`);
  }
  return stdout.trim();
}
