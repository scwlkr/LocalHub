import type { VerifiedReleaseCandidate } from "./release.ts";

export const EVIDENCE_SCHEMA = "localhub.release-evidence/v1";

export type EvidenceStatus = "Passed" | "Failed" | "Blocked" | "Not applicable";
export type EvidenceClassification = "Mandatory" | "Conditional";
export type EvidenceSeam = "assembled-release" | "controlled-external-dependency";

export interface EvidenceAttempt {
  status: "Failed" | "Blocked";
  observed: string;
  correction: string | null;
  timestamp: string;
}

export interface EvidenceGate {
  journeyGateId: string;
  requirementIds: string[];
  classification: EvidenceClassification;
  status: EvidenceStatus;
  action: string;
  expected: string;
  observed: string;
  artifactLinks: string[];
  tester: string;
  timestamp: string;
  priorAttempts: EvidenceAttempt[];
}

export interface EvidenceEnvironment {
  hostHardware: string;
  hostOsVersion: string;
  toolRunnerHardware: string | null;
  toolRunnerOsVersion: string | null;
  browsers: string[];
  networkLane: string;
  modelVariantHashes: string[];
  companionHashes: string[];
  chatTemplate: string | null;
  runProfileRevision: string | null;
  effectiveSettings: string | null;
  testDate: string;
}

export interface EvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA;
  evidenceId: string;
  seam: EvidenceSeam;
  candidate: {
    candidateId: string;
    commit: string;
    assetSha256: string;
    manifestSha256: string;
  };
  environment: EvidenceEnvironment;
  gates: EvidenceGate[];
}

export interface ValidatedEvidenceRecord extends EvidenceRecord {
  releaseEvidence: boolean;
}

const STATUSES = new Set<EvidenceStatus>(["Passed", "Failed", "Blocked", "Not applicable"]);

export function validateEvidenceRecord(
  input: unknown,
  candidate: VerifiedReleaseCandidate,
  now = new Date(),
): ValidatedEvidenceRecord {
  if (!isRecord(input)) {
    throw new Error("Evidence must be a JSON object.");
  }
  if (input.schema !== EVIDENCE_SCHEMA) {
    throw new Error(`Unsupported evidence schema: ${String(input.schema)}`);
  }
  assertSanitized(input);
  if (input.seam !== "assembled-release" && input.seam !== "controlled-external-dependency") {
    throw new Error("Evidence seam is missing or ambiguous.");
  }
  if (!isRecord(input.candidate)) {
    throw new Error("Evidence candidate identity is missing.");
  }
  verifyCandidateIdentity(input.candidate, candidate);
  verifyEnvironment(input.environment);
  if (!Array.isArray(input.gates) || input.gates.length === 0) {
    throw new Error("Evidence must contain at least one gate record.");
  }

  const assembledAt = parseTimestamp(candidate.candidate.assembledAt, "candidate assembledAt");
  const gates = input.gates.map((gate, index) =>
    verifyGate(gate, index, assembledAt, now.getTime()),
  );
  const record = input as unknown as EvidenceRecord;
  return { ...record, gates, releaseEvidence: record.seam === "assembled-release" };
}

function verifyCandidateIdentity(
  identity: Record<string, unknown>,
  candidate: VerifiedReleaseCandidate,
): void {
  const expected = {
    candidateId: candidate.candidate.candidateId,
    commit: candidate.manifest.release.commit,
    assetSha256: candidate.candidate.asset.sha256,
    manifestSha256: candidate.candidate.manifest.sha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (identity[key] !== value) {
      throw new Error(`Evidence ${key} does not match the assembled candidate.`);
    }
  }
}

function verifyEnvironment(value: unknown): asserts value is EvidenceEnvironment {
  if (!isRecord(value)) {
    throw new Error("Evidence environment is missing.");
  }
  for (const field of ["hostHardware", "hostOsVersion", "networkLane", "testDate"] as const) {
    expectNonEmptyString(value[field], `environment.${field}`);
  }
  for (const field of ["browsers", "modelVariantHashes", "companionHashes"] as const) {
    if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === "string")) {
      throw new Error(`Evidence environment.${field} must be an array of strings.`);
    }
  }
  for (const field of [
    "toolRunnerHardware",
    "toolRunnerOsVersion",
    "chatTemplate",
    "runProfileRevision",
    "effectiveSettings",
  ] as const) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw new Error(`Evidence environment.${field} must be a string or null.`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.testDate))) {
    throw new Error("Evidence environment.testDate must use YYYY-MM-DD.");
  }
}

function verifyGate(value: unknown, index: number, assembledAt: number, now: number): EvidenceGate {
  const label = `gate ${index + 1}`;
  if (!isRecord(value)) {
    throw new Error(`Evidence ${label} must be an object.`);
  }
  expectNonEmptyString(value.journeyGateId, `${label}.journeyGateId`);
  if (!/^LH-J[1-8]-\d{3}$/.test(value.journeyGateId)) {
    throw new Error(`Evidence ${label}.journeyGateId is not a stable journey gate ID.`);
  }
  if (
    !Array.isArray(value.requirementIds) ||
    value.requirementIds.length === 0 ||
    !value.requirementIds.every(
      (item) => typeof item === "string" && /^LH-[A-Z]+-\d{3}$/.test(item),
    )
  ) {
    throw new Error(`Evidence ${label}.requirementIds must contain stable requirement IDs.`);
  }
  if (value.classification !== "Mandatory" && value.classification !== "Conditional") {
    throw new Error(`Evidence ${label}.classification is invalid.`);
  }
  if (typeof value.status !== "string" || !STATUSES.has(value.status as EvidenceStatus)) {
    throw new Error(`Evidence ${label}.status is invalid.`);
  }
  if (value.status === "Not applicable" && value.classification !== "Conditional") {
    throw new Error("Not applicable is allowed only for a conditional capability.");
  }
  for (const field of ["action", "expected", "observed", "tester"] as const) {
    expectNonEmptyString(value[field], `${label}.${field}`);
  }
  if (!Array.isArray(value.artifactLinks) || !value.artifactLinks.every(isArtifactLink)) {
    throw new Error(`Evidence ${label}.artifactLinks must contain HTTPS links.`);
  }
  const timestamp = parseTimestamp(value.timestamp, `${label}.timestamp`);
  if (timestamp < assembledAt) {
    throw new Error(`Evidence ${label} is stale for this assembled candidate.`);
  }
  if (timestamp > now) {
    throw new Error(`Evidence ${label} timestamp is in the future.`);
  }
  if (!Array.isArray(value.priorAttempts)) {
    throw new Error(`Evidence ${label}.priorAttempts must be an array.`);
  }
  const priorAttempts = value.priorAttempts.map((attempt, attemptIndex) =>
    verifyAttempt(attempt, label, attemptIndex, assembledAt, now),
  );

  return { ...(value as unknown as EvidenceGate), priorAttempts };
}

function verifyAttempt(
  value: unknown,
  gateLabel: string,
  index: number,
  assembledAt: number,
  now: number,
): EvidenceAttempt {
  const label = `${gateLabel}.priorAttempts[${index}]`;
  if (!isRecord(value) || (value.status !== "Failed" && value.status !== "Blocked")) {
    throw new Error(`Evidence ${label} must retain a Failed or Blocked attempt.`);
  }
  expectNonEmptyString(value.observed, `${label}.observed`);
  if (value.correction !== null && typeof value.correction !== "string") {
    throw new Error(`Evidence ${label}.correction must be a string or null.`);
  }
  const timestamp = parseTimestamp(value.timestamp, `${label}.timestamp`);
  if (timestamp < assembledAt || timestamp > now) {
    throw new Error(`Evidence ${label} timestamp does not belong to this candidate run.`);
  }
  return value as unknown as EvidenceAttempt;
}

function isArtifactLink(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new Error(`Evidence ${label} must be an ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Evidence ${label} must be an exact ISO timestamp.`);
  }
  return parsed;
}

function expectNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Evidence ${label} must be a non-empty string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSanitized(value: unknown): void {
  const strings: string[] = [];
  collectStrings(value, strings);
  const credential =
    /\b(?:authorization\s*:\s*\S+|bearer\s+\S+|(?:api[ _-]?key|password|secret)\s*[:=]\s*\S+)/i;
  const privateHostname = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)*\.local\b/i;
  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const privatePath = /(?:\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/;
  if (
    strings.some(
      (item) =>
        credential.test(item) ||
        privateHostname.test(item) ||
        ipv4.test(item) ||
        privatePath.test(item),
    )
  ) {
    throw new Error("Evidence contains prohibited sensitive material.");
  }
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
}
