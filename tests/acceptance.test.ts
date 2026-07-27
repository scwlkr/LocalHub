import { expect, test } from "bun:test";
import { runCandidateSmoke, type AcceptanceDependencies } from "../src/acceptance.ts";
import { validateEvidenceRecord, type EvidenceEnvironment } from "../src/evidence.ts";
import {
  RELEASE_CANDIDATE_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  UNNOTARIZED_TRUST_STATEMENT,
  type VerifiedReleaseCandidate,
} from "../src/release.ts";

test("controlled external conditions drive only public commands and never become release evidence", async () => {
  const commands: string[][] = [];
  const dependencies: AcceptanceDependencies = {
    process: {
      run: async (command) => {
        commands.push(command);
        const argument = command[1];
        if (argument === "release") {
          return { code: 0, stdout: '{"candidateId":"verified"}', stderr: "" };
        }
        if (argument === "--help") {
          return { code: 0, stdout: "Usage: lh", stderr: "" };
        }
        if (argument === "--version") {
          return { code: 0, stdout: "0.1.1", stderr: "" };
        }
        return {
          code: 1,
          stdout: "private-machine.local must never enter evidence",
          stderr: "",
        };
      },
    },
    clock: { now: () => new Date("2026-07-27T19:00:00.000Z") },
    storage: { read: async () => new Uint8Array() },
    network: { fetch: async () => new Response(null, { status: 503 }) },
    llamaCpp: { origin: "http://controlled-llama.invalid" },
    responses: { origin: "http://controlled-responses.invalid" },
    failure: { activate: async () => undefined },
  };
  const candidate = verifiedCandidate();

  const record = await runCandidateSmoke(
    {
      candidate,
      candidateRecordPath: "/candidate/release-candidate.json",
      executablePath: "/candidate/lh",
      evidenceId: "t01-controlled-smoke",
      environment: environment(),
      seam: "controlled-external-dependency",
      artifactLinks: ["https://github.com/scwlkr/LocalHub/actions/runs/1"],
    },
    dependencies,
  );
  const validated = validateEvidenceRecord(record, candidate, new Date("2026-07-27T20:00:00.000Z"));

  expect(commands).toEqual([
    ["/candidate/lh", "release", "identity", "/candidate/release-candidate.json"],
    ["/candidate/lh", "--help"],
    ["/candidate/lh", "--version"],
    ["/candidate/lh", "status"],
  ]);
  expect(validated.releaseEvidence).toBe(false);
  expect(validated.gates).toHaveLength(1);
  expect(validated.gates[0]?.status).toBe("Passed");
  expect(JSON.stringify(record)).not.toContain("private-machine.local");
  expect(JSON.stringify(record)).not.toContain("controlled-llama.invalid");
});

function environment(): EvidenceEnvironment {
  return {
    hostHardware: "Controlled Apple Silicon lane",
    hostOsVersion: "macOS 27.0 (26A5388g)",
    toolRunnerHardware: null,
    toolRunnerOsVersion: null,
    browsers: [],
    networkLane: "Controlled external dependency seam",
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
    testDate: "2026-07-27",
  };
}

function verifiedCandidate(): VerifiedReleaseCandidate {
  const asset = { path: "lh", size: 20, sha256: "1".repeat(64) };
  return {
    candidate: {
      schema: RELEASE_CANDIDATE_SCHEMA,
      candidateId: "localhub-0.1.1-test-darwin-arm64",
      assembledAt: "2026-07-27T18:00:00.000Z",
      asset,
      manifest: { path: "release-manifest.json", size: 100, sha256: "2".repeat(64) },
    },
    manifest: {
      schema: RELEASE_MANIFEST_SCHEMA,
      candidateId: "localhub-0.1.1-test-darwin-arm64",
      release: { product: "LocalHub", version: "0.1.1", commit: "a".repeat(40), tag: null },
      asset,
      target: {
        platform: "darwin",
        architecture: "arm64",
        minimumOsVersion: "15.0",
        testedOsVersion: "27.0 (26A5388g)",
      },
      stateSchema: "localhub-legacy-config/v1",
      trust: { state: "unnotarized", statement: UNNOTARIZED_TRUST_STATEMENT },
      rollbackTarget: "legacy-lh@0.1.1",
      dependencies: [
        { name: "LocalHub", version: "0.1.1", included: true },
        { name: "Bun", version: "1.3.14", included: true },
        { name: "llama.cpp", version: "b10107", included: false },
        { name: "Codex", version: "0.145.0", included: false },
        { name: "SearXNG", version: "2026.5.31-7159b8aed", included: false },
      ],
    },
  };
}
