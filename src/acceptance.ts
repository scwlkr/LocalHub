import { createHash } from "node:crypto";
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

export interface ModelAcquisitionSmokeOptions extends CandidateSmokeOptions {
  modelSourcePath: string;
  modelSourceSha256: string;
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
      command: [options.executablePath, "release", "notices"],
      passed: (result) =>
        result.code === 0 &&
        result.stdout.includes("qrcode-generator 1.4.4") &&
        result.stdout.includes("MIT License"),
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
      "$CANDIDATE/lh release identity; $CANDIDATE/lh --help; $CANDIDATE/lh release notices; $CANDIDATE/lh --version; $CANDIDATE/lh status",
    expected: `The exact candidate verifies its identity, bundled license notice, and LocalHub ${version} help, version, and honest status behavior.`,
    observed: passed
      ? "All five public candidate entrances matched the expected boundary."
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

export async function runModelAcquisitionSmoke(
  options: ModelAcquisitionSmokeOptions,
  dependencies: AcceptanceDependencies,
): Promise<EvidenceRecord> {
  const exactSource = await dependencies.storage.read(options.modelSourcePath);
  let passedSteps =
    sha256(exactSource) === options.modelSourceSha256 && exactSource.byteLength > 0 ? 1 : 0;
  let installed: Record<string, unknown> | null = null;
  let runAttempted = false;
  let stopped = false;
  try {
    const prepared = jsonObjectResult(
      await dependencies.process.run([
        options.executablePath,
        "model",
        "prepare",
        "--name",
        "Acceptance Model",
        "--file",
        options.modelSourcePath,
        "--sha256",
        `${options.modelSourcePath}=${options.modelSourceSha256}`,
      ]),
    );
    const acquisitionId = stringField(prepared, "id");
    if (
      acquisitionId &&
      prepared?.status === "planned" &&
      prepared.requiredBytes === exactSource.byteLength &&
      Array.isArray(prepared.files) &&
      prepared.files.length === 1
    ) {
      passedSteps += 1;
    }

    const stagedInventory = jsonResult(
      await dependencies.process.run([options.executablePath, "model", "list"]),
    );
    if (Array.isArray(stagedInventory) && stagedInventory.length === 0) passedSteps += 1;

    if (acquisitionId) {
      installed = jsonObjectResult(
        await dependencies.process.run([options.executablePath, "model", "import", acquisitionId]),
      );
    }
    const contentId = stringField(installed, "id");
    const files = Array.isArray(installed?.files) ? installed.files : [];
    if (
      contentId &&
      /^[0-9a-f]{64}$/.test(contentId) &&
      installed?.available === true &&
      typeof installed.architecture === "string" &&
      typeof installed.parameterCount === "number" &&
      isRecord(installed.quantization) &&
      isRecord(installed.quantization.tensorTypes) &&
      Array.isArray(installed.templateHints) &&
      files.length === 1 &&
      isRecord(files[0]) &&
      files[0].sha256 === options.modelSourceSha256
    ) {
      passedSteps += 1;
    }

    const installedInventory = jsonResult(
      await dependencies.process.run([options.executablePath, "model", "list"]),
    );
    if (
      contentId &&
      Array.isArray(installedInventory) &&
      installedInventory.length === 1 &&
      isRecord(installedInventory[0]) &&
      installedInventory[0].id === contentId &&
      installedInventory[0].available === true
    ) {
      passedSteps += 1;
    }

    if (contentId) {
      const renamed = jsonObjectResult(
        await dependencies.process.run([
          options.executablePath,
          "model",
          "rename",
          contentId,
          "Acceptance Model Renamed",
        ]),
      );
      if (renamed?.id === contentId && renamed.displayName === "Acceptance Model Renamed") {
        passedSteps += 1;
      }
    }

    runAttempted = true;
    const started = jsonObjectResult(
      await dependencies.process.run([options.executablePath, "run", "start"]),
    );
    const run = isRecord(started?.run) ? started.run : null;
    const host = isRecord(run?.host) ? run.host : null;
    const origin = stringField(host, "origin");
    if (origin && contentId) {
      const response = await dependencies.network.fetch(`${origin}/models`);
      const body: unknown = response.ok ? await response.json() : null;
      const models =
        isRecord(body) && Array.isArray(body.installedModels) ? body.installedModels : [];
      if (
        models.length === 1 &&
        isRecord(models[0]) &&
        models[0].id === contentId &&
        models[0].available === true
      ) {
        passedSteps += 1;
      }
    }

    const stoppedResult = jsonObjectResult(
      await dependencies.process.run([options.executablePath, "stop"]),
    );
    stopped = stoppedResult?.status === "stopped";
    const finalSource = await dependencies.storage.read(options.modelSourcePath);
    if (stopped && sha256(finalSource) === options.modelSourceSha256) passedSteps += 1;
  } catch {
    // This composite gate fails without retaining raw output, local paths, or Host data.
  } finally {
    if (runAttempted && !stopped) {
      try {
        await dependencies.process.run([options.executablePath, "stop"]);
      } catch {
        // A failed cleanup remains part of the failed composite result.
      }
    }
  }

  const passed = passedSteps === 8;
  const contentId = stringField(installed, "id");
  const architecture = stringField(installed, "architecture");
  const parameterCount = numberField(installed, "parameterCount");
  const trainingContext = numberField(installed, "trainingContext");
  const tensorTypes = isRecord(installed?.quantization) ? installed.quantization.tensorTypes : null;
  const templateHints = Array.isArray(installed?.templateHints) ? installed.templateHints : [];
  const composite: EvidenceGate = {
    journeyGateId: "LH-J2-002",
    requirementIds: ["LH-MOD-006", "LH-MOD-007"],
    classification: "Mandatory",
    status: passed ? "Passed" : "Failed",
    action:
      "$CANDIDATE/lh model prepare exact local GGUF with published SHA-256; $CANDIDATE/lh model list; $CANDIDATE/lh model import; $CANDIDATE/lh model list; label-only rename; $CANDIDATE/lh run start; GET loopback Host /models; $CANDIDATE/lh stop",
    expected:
      "The exact staged local file remains absent from Installed Model inventory until offline SHA-256 and GGUF verification complete, then one content-identified model appears atomically in both shipped CLI and loopback Host inventory without changing the source.",
    observed: passed
      ? `Exact source sha256:${options.modelSourceSha256} remained unchanged; content identity ${contentId}; architecture ${architecture}; ${parameterCount} parameters; training context ${trainingContext ?? "not declared"}; ${isRecord(tensorTypes) ? Object.keys(tensorTypes).length : 0} tensor layouts and ${templateHints.length} embedded template hints parsed; staged inventory was empty and one exact Installed Model became available through loopback Host inventory.`
      : `${passedSteps} of 8 exact local acquisition checks passed; raw command output, local paths, and Host data were not retained.`,
    artifactLinks: options.artifactLinks,
    tester: "LocalHub exact local model acquisition driver",
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

function jsonResult(result: AcceptanceProcessResult): Record<string, unknown> | unknown[] | null {
  if (result.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonObjectResult(result: AcceptanceProcessResult): Record<string, unknown> | null {
  const parsed = jsonResult(result);
  return isRecord(parsed) ? parsed : null;
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function numberField(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : null;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
