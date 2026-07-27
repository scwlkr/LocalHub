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
  command: string[];
  passed(result: AcceptanceProcessResult): boolean;
}

export async function runCandidateSmoke(
  options: CandidateSmokeOptions,
  dependencies: AcceptanceDependencies,
): Promise<EvidenceRecord> {
  const version = options.candidate.manifest.release.version;
  const gates: SmokeGate[] = [
    {
      command: [options.executablePath, "release", "identity", options.candidateRecordPath],
      passed: (result) => result.code === 0,
    },
    {
      command: [options.executablePath, "--help"],
      passed: (result) => result.code === 0 && result.stdout.includes("Usage:"),
    },
    {
      command: [options.executablePath, "--version"],
      passed: (result) => result.code === 0 && result.stdout.trim() === version,
    },
    {
      command: [options.executablePath, "status"],
      passed: (result) => result.code === 0 || result.code === 1,
    },
  ];

  let passedSteps = 0;
  for (const gate of gates) {
    try {
      const result = await dependencies.process.run(gate.command);
      if (gate.passed(result)) {
        passedSteps += 1;
      }
    } catch {
      // The composite gate fails. Raw exception text may contain private paths or host data.
    }
  }
  const passed = passedSteps === gates.length;
  const composite: EvidenceGate = {
    journeyGateId: "LH-J1-001",
    requirementIds: ["LH-GOV-011", "LH-PIN-005", "LH-TST-001", "LH-EVD-001"],
    classification: "Mandatory",
    status: passed ? "Passed" : "Failed",
    action:
      "$CANDIDATE/lh release identity; $CANDIDATE/lh --help; $CANDIDATE/lh --version; $CANDIDATE/lh status",
    expected: `The exact candidate verifies its identity and preserves LocalHub ${version} help, version, and honest status behavior.`,
    observed: passed
      ? "All four public candidate entrances matched the expected boundary."
      : `${passedSteps} of ${gates.length} public candidate entrances matched; captured output was not retained.`,
    artifactLinks: options.artifactLinks,
    tester: "LocalHub candidate acceptance driver",
    timestamp: dependencies.clock.now().toISOString(),
    priorAttempts: [],
  };
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
    gates: [composite],
  };
}
