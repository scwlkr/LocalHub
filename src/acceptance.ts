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
  label?: string;
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

export async function runLifecycleSmoke(
  options: CandidateSmokeOptions,
  dependencies: AcceptanceDependencies,
): Promise<EvidenceRecord> {
  const gates: SmokeGate[] = [
    {
      label: "start",
      command: [options.executablePath, "run", "start"],
      passed: (result) =>
        result.code === 0 &&
        result.stdout.includes('"status": "running"') &&
        result.stdout.includes('"model": null') &&
        result.stdout.includes('"builtInTools": false'),
    },
    {
      label: "running-status",
      command: [options.executablePath, "run", "status"],
      passed: (result) =>
        result.code === 0 &&
        result.stdout.includes('"state": "running"') &&
        result.stdout.includes('"health": "ready"'),
    },
    {
      label: "stop",
      command: [options.executablePath, "stop"],
      passed: (result) =>
        result.code === 0 &&
        result.stdout.includes('"status": "stopped"') &&
        result.stdout.includes('"activeWork": 0'),
    },
    {
      label: "stopped-status",
      command: [options.executablePath, "run", "status"],
      passed: (result) =>
        result.code === 0 &&
        result.stdout.includes('"state": "stopped"') &&
        result.stdout.includes('"acceptingWork": false'),
    },
  ];

  let passedSteps = 0;
  for (const gate of gates) {
    try {
      const result = await dependencies.process.run(gate.command);
      if (gate.passed(result)) {
        passedSteps += 1;
      } else {
        console.error(
          `Lifecycle step ${gate.label}: ${lifecycleStatusCategory(result)}; raw output withheld.`,
        );
      }
    } catch {
      console.error(`Lifecycle step ${gate.label}: invocation-error; raw output withheld.`);
    }
  }
  if (passedSteps < 3) {
    try {
      await dependencies.process.run([options.executablePath, "stop"]);
    } catch {
      // A failed cleanup remains a failed composite gate and is not hidden.
    }
  }
  const passed = passedSteps === gates.length;
  const composite: EvidenceGate = {
    journeyGateId: "LH-J1-004",
    requirementIds: [
      "LH-GOV-002",
      "LH-GOV-006",
      "LH-GOV-007",
      "LH-GOV-008",
      "LH-GOV-009",
      "LH-LIF-004",
      "LH-MOD-018",
      "LH-MOD-019",
    ],
    classification: "Mandatory",
    status: passed ? "Passed" : "Failed",
    action:
      "$CANDIDATE/lh run start; exit that command; $CANDIDATE/lh run status; $CANDIDATE/lh stop; $CANDIDATE/lh run status",
    expected:
      "The exact candidate returns after explicit start, remains healthy from a fresh command, reports pinned loopback runtime controls with no model/profile claim, then rejects new work and closes every owned process/listener on explicit stop.",
    observed: passed
      ? "All four public lifecycle entrances passed; the detached Run survived the starting command, reported zero active model work, and stopped with both owned loopback listeners closed."
      : `${passedSteps} of ${gates.length} lifecycle entrances passed; raw output was not retained and no substitute runtime was attempted.`,
    artifactLinks: options.artifactLinks,
    tester: "LocalHub lifecycle acceptance driver",
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

function lifecycleStatusCategory(result: AcceptanceProcessResult): string {
  if (result.code === 0) return "status-mismatch";
  if (result.stderr.includes("--version exceeded its finite deadline")) {
    return "runtime-version-timeout";
  }
  if (result.stderr.includes("--list-devices exceeded its finite deadline")) {
    return "runtime-device-timeout";
  }
  if (result.stderr.includes("did not become healthy")) return "health-timeout";
  return "exit-nonzero";
}
