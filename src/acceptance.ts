import {
  EVIDENCE_SCHEMA,
  type EvidenceEnvironment,
  type EvidenceGate,
  type EvidenceRecord,
  type EvidenceSeam,
} from "./evidence.ts";
import type { VerifiedReleaseCandidate } from "./release.ts";

export interface AcceptanceProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AcceptanceDependencies {
  process: {
    run(command: string[]): Promise<AcceptanceProcessResult>;
  };
  clock: {
    now(): Date;
  };
  storage: {
    read(path: string): Promise<Uint8Array>;
  };
  network: {
    fetch(input: string | URL | Request): Promise<Response>;
  };
  llamaCpp: {
    origin: string;
  };
  responses: {
    origin: string;
  };
  failure: {
    activate(name: string): Promise<void>;
  };
}

export interface CandidateSmokeOptions {
  candidate: VerifiedReleaseCandidate;
  candidateRecordPath: string;
  executablePath: string;
  evidenceId: string;
  environment: EvidenceEnvironment;
  seam: EvidenceSeam;
  artifactLinks: string[];
}

interface SmokeGate {
  action: string;
  command: string[];
  expected: string;
  requirementIds: string[];
  passed(result: AcceptanceProcessResult): boolean;
}

export async function runCandidateSmoke(
  options: CandidateSmokeOptions,
  dependencies: AcceptanceDependencies,
): Promise<EvidenceRecord> {
  const version = options.candidate.manifest.release.version;
  const gates: SmokeGate[] = [
    {
      action: "$CANDIDATE/lh release identity $CANDIDATE/release-candidate.json",
      command: [options.executablePath, "release", "identity", options.candidateRecordPath],
      expected: "The shipped command verifies and reports the exact candidate identity.",
      requirementIds: ["LH-PIN-005", "LH-EVD-001"],
      passed: (result) => result.code === 0,
    },
    {
      action: "$CANDIDATE/lh --help",
      command: [options.executablePath, "--help"],
      expected: "The assembled candidate exposes legacy help.",
      requirementIds: ["LH-GOV-011"],
      passed: (result) => result.code === 0 && result.stdout.includes("Usage:"),
    },
    {
      action: "$CANDIDATE/lh --version",
      command: [options.executablePath, "--version"],
      expected: `The assembled candidate reports LocalHub ${version}.`,
      requirementIds: ["LH-PIN-005"],
      passed: (result) => result.code === 0 && result.stdout.trim() === version,
    },
    {
      action: "$CANDIDATE/lh status",
      command: [options.executablePath, "status"],
      expected: "Legacy status executes and reports its real ready or unavailable state.",
      requirementIds: ["LH-TST-001"],
      passed: (result) => result.code === 0 || result.code === 1,
    },
  ];

  const records: EvidenceGate[] = [];
  for (const gate of gates) {
    records.push(await runSmokeGate(gate, options.artifactLinks, dependencies));
  }
  return {
    schema: EVIDENCE_SCHEMA,
    evidenceId: options.evidenceId,
    seam: options.seam,
    candidate: {
      candidateId: options.candidate.candidate.candidateId,
      commit: options.candidate.manifest.release.commit,
      assetSha256: options.candidate.candidate.asset.sha256,
      manifestSha256: options.candidate.candidate.manifest.sha256,
    },
    environment: options.environment,
    gates: records,
  };
}

async function runSmokeGate(
  gate: SmokeGate,
  artifactLinks: string[],
  dependencies: AcceptanceDependencies,
): Promise<EvidenceGate> {
  let status: EvidenceGate["status"] = "Failed";
  let observed = "The public command failed before returning a result.";
  try {
    const result = await dependencies.process.run(gate.command);
    status = gate.passed(result) ? "Passed" : "Failed";
    observed =
      status === "Passed"
        ? "The public command matched the expected boundary."
        : `The public command exited ${result.code}; captured output was not retained.`;
  } catch {
    // The result remains Failed. Raw exception text may contain private paths or host data.
  }
  return {
    journeyGateId: "LH-J1-001",
    requirementIds: gate.requirementIds,
    classification: "Mandatory",
    status,
    action: gate.action,
    expected: gate.expected,
    observed,
    artifactLinks,
    tester: "LocalHub candidate acceptance driver",
    timestamp: dependencies.clock.now().toISOString(),
    priorAttempts: [],
  };
}
