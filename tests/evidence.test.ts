import { expect, test } from "bun:test";
import { EVIDENCE_SCHEMA, validateEvidenceRecord } from "../src/evidence.ts";
import {
  RELEASE_CANDIDATE_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  UNNOTARIZED_TRUST_STATEMENT,
  type VerifiedReleaseCandidate,
} from "../src/release.ts";

test("evidence records retain every honest gate status for one exact assembled candidate", () => {
  const candidate = verifiedCandidate();
  const record = {
    schema: EVIDENCE_SCHEMA,
    evidenceId: "t01-deterministic-test",
    seam: "assembled-release",
    candidate: {
      candidateId: candidate.candidate.candidateId,
      commit: candidate.manifest.release.commit,
      assetSha256: candidate.candidate.asset.sha256,
      manifestSha256: candidate.candidate.manifest.sha256,
    },
    environment: {
      hostHardware: "Apple Silicon test lane",
      hostOsVersion: "macOS 27.0 (26A5388g)",
      toolRunnerHardware: null,
      toolRunnerOsVersion: null,
      browsers: [],
      networkLane: "Local assembled candidate",
      modelVariantHashes: [],
      companionHashes: [],
      chatTemplate: null,
      runProfileRevision: null,
      effectiveSettings: null,
      testDate: "2026-07-27",
    },
    gates: [
      gate("LH-J1-001", "Mandatory", "Passed"),
      gate("LH-J1-005", "Mandatory", "Failed"),
      gate("LH-J7-003", "Mandatory", "Blocked"),
      gate("LH-J5-002", "Conditional", "Not applicable"),
    ],
  };

  const validated = validateEvidenceRecord(record, candidate, new Date("2026-07-27T20:00:00.000Z"));

  expect(validated.gates.map((item) => item.status)).toEqual([
    "Passed",
    "Failed",
    "Blocked",
    "Not applicable",
  ]);
  expect(validated.releaseEvidence).toBe(true);
});

test("evidence validation rejects credentials, private hostnames, and IP addresses", () => {
  const candidate = verifiedCandidate();
  const base = {
    schema: EVIDENCE_SCHEMA,
    evidenceId: "t01-redaction-test",
    seam: "assembled-release",
    candidate: {
      candidateId: candidate.candidate.candidateId,
      commit: candidate.manifest.release.commit,
      assetSha256: candidate.candidate.asset.sha256,
      manifestSha256: candidate.candidate.manifest.sha256,
    },
    environment: {
      hostHardware: "Apple Silicon test lane",
      hostOsVersion: "macOS 27.0 (26A5388g)",
      toolRunnerHardware: null,
      toolRunnerOsVersion: null,
      browsers: [],
      networkLane: "Local assembled candidate",
      modelVariantHashes: [],
      companionHashes: [],
      chatTemplate: null,
      runProfileRevision: null,
      effectiveSettings: null,
      testDate: "2026-07-27",
    },
    gates: [gate("LH-J1-001", "Mandatory", "Passed")],
  };

  for (const prohibited of [
    "Authorization: Bearer super-secret",
    "private-machine.local",
    "Observed public address 8.8.8.8",
  ]) {
    const record = structuredClone(base);
    const firstGate = record.gates[0];
    if (!firstGate) {
      throw new Error("Missing fixture gate.");
    }
    firstGate.observed = prohibited;
    expect(() =>
      validateEvidenceRecord(record, candidate, new Date("2026-07-27T20:00:00.000Z")),
    ).toThrow("Evidence contains prohibited sensitive material.");
  }
});

function gate(
  journeyGateId: string,
  classification: "Mandatory" | "Conditional",
  status: "Passed" | "Failed" | "Blocked" | "Not applicable",
) {
  return {
    journeyGateId,
    requirementIds: ["LH-EVD-003"],
    classification,
    status,
    action: "$CANDIDATE/lh --help",
    expected: "The assembled command reports public help.",
    observed: `Gate recorded as ${status}.`,
    artifactLinks: ["https://github.com/scwlkr/LocalHub/actions/runs/1"],
    tester: "LocalHub automated acceptance",
    timestamp: "2026-07-27T19:00:00.000Z",
    priorAttempts: [],
  };
}

function verifiedCandidate(): VerifiedReleaseCandidate {
  return {
    candidate: {
      schema: RELEASE_CANDIDATE_SCHEMA,
      candidateId: "localhub-0.1.1-test-darwin-arm64",
      assembledAt: "2026-07-27T18:00:00.000Z",
      asset: { path: "lh", size: 20, sha256: "1".repeat(64) },
      manifest: { path: "release-manifest.json", size: 100, sha256: "2".repeat(64) },
    },
    manifest: {
      schema: RELEASE_MANIFEST_SCHEMA,
      candidateId: "localhub-0.1.1-test-darwin-arm64",
      release: { product: "LocalHub", version: "0.1.1", commit: "a".repeat(40), tag: null },
      asset: { path: "lh", size: 20, sha256: "1".repeat(64) },
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
