import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const RELEASE_CANDIDATE_SCHEMA = "localhub.release-candidate/v1";
export const RELEASE_MANIFEST_SCHEMA = "localhub.release-manifest/v1";

export const UNNOTARIZED_TRUST_STATEMENT =
  "Checksum verified and ad-hoc signed, but not notarized or reviewed by Apple. macOS may block first launch. Use System Settings → Privacy & Security → Open Anyway. Never disable Gatekeeper.";
export const APPLE_NOTARIZED_TRUST_STATEMENT =
  "Signed with LocalHub's Apple Developer ID, notarized by Apple, and checksum verified. Notarization checks for known malware; it is not App Store review.";

const REQUIRED_DEPENDENCIES = [
  {
    name: "Bun",
    version: "1.3.14",
    included: true,
    digest: "sha256:d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
  },
  {
    name: "llama.cpp",
    version: "b10107",
    included: false,
    commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9",
    digest: "sha256:b9554ab4c9f6e91199f48387cb4ab27466fb1d724881f81463ef03f6370cfa32",
  },
  { name: "Codex", version: "0.145.0", included: false },
  {
    name: "SearXNG",
    version: "2026.5.31-7159b8aed",
    included: false,
    digest: "sha256:6b5787eb43a997e1214f627480068396e434b0ba5b3761be382dcd3daa9e006a",
  },
] as const;

export interface FileIdentity {
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseCandidate {
  schema: typeof RELEASE_CANDIDATE_SCHEMA;
  candidateId: string;
  assembledAt: string;
  asset: FileIdentity;
  manifest: FileIdentity;
}

export interface ReleaseDependency {
  name: "LocalHub" | "Bun" | "llama.cpp" | "Codex" | "SearXNG";
  version: string;
  included: boolean;
  commit?: string;
  digest?: string;
}

export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  candidateId: string;
  release: {
    product: "LocalHub";
    version: string;
    commit: string;
    tag: string | null;
  };
  asset: FileIdentity;
  target: {
    platform: "darwin";
    architecture: "arm64";
    minimumOsVersion: string;
    testedOsVersion: string;
  };
  stateSchema: string;
  trust: {
    state: "apple-notarized" | "unnotarized";
    statement: string;
  };
  rollbackTarget: string;
  dependencies: ReleaseDependency[];
}

export interface VerifiedReleaseCandidate {
  candidate: ReleaseCandidate;
  manifest: ReleaseManifest;
}

export interface ReleaseAssetInspection {
  format: "mach-o" | "other";
  architecture: "arm64" | "other";
  signature: "adhoc" | "developer-id" | "invalid";
}

export interface ReleaseVerificationOptions {
  buildCommit: string;
  inspectAsset?: (path: string) => Promise<ReleaseAssetInspection>;
}

export interface ExpandReleaseManifestOptions {
  asset: FileIdentity;
  commit: string;
  tag: string | null;
  testedOsVersion: string;
  version: string;
}

export interface AssembleExpandCandidateOptions
  extends Omit<ExpandReleaseManifestOptions, "asset"> {
  assembledAt: Date;
  outputDirectory: string;
  sourceExecutable: string;
}

export interface AssembledCandidatePaths {
  candidateRecordPath: string;
  executablePath: string;
  manifestPath: string;
}

export function createExpandReleaseManifest(
  options: ExpandReleaseManifestOptions,
): ReleaseManifest {
  if (!/^[0-9a-f]{40}$/.test(options.commit)) {
    throw new Error("Release commit must be a full lowercase Git commit.");
  }
  const candidateId = `localhub-${options.version}-${options.commit.slice(0, 12)}-darwin-arm64`;
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    candidateId,
    release: {
      product: "LocalHub",
      version: options.version,
      commit: options.commit,
      tag: options.tag,
    },
    asset: options.asset,
    target: {
      platform: "darwin",
      architecture: "arm64",
      minimumOsVersion: "15.0",
      testedOsVersion: options.testedOsVersion,
    },
    stateSchema: "localhub-legacy-config/v1",
    trust: { state: "unnotarized", statement: UNNOTARIZED_TRUST_STATEMENT },
    rollbackTarget: `legacy-lh@${options.version}`,
    dependencies: [
      { name: "LocalHub", version: options.version, included: true, commit: options.commit },
      ...REQUIRED_DEPENDENCIES.map((dependency) => ({ ...dependency })),
    ],
  };
}

export async function assembleExpandCandidate(
  options: AssembleExpandCandidateOptions,
): Promise<AssembledCandidatePaths> {
  if (!Number.isFinite(options.assembledAt.getTime())) {
    throw new Error("Candidate assembly time must be an exact timestamp.");
  }
  await mkdir(options.outputDirectory);
  const executablePath = join(options.outputDirectory, "lh");
  const manifestPath = join(options.outputDirectory, "release-manifest.json");
  const candidateRecordPath = join(options.outputDirectory, "release-candidate.json");
  await copyFile(options.sourceExecutable, executablePath);
  await chmod(executablePath, 0o755);

  const asset = { path: "lh", ...(await fileIdentity(executablePath)) };
  const manifest = createExpandReleaseManifest({
    asset,
    commit: options.commit,
    tag: options.tag,
    testedOsVersion: options.testedOsVersion,
    version: options.version,
  });
  await writeJson(manifestPath, manifest);
  const candidate: ReleaseCandidate = {
    schema: RELEASE_CANDIDATE_SCHEMA,
    candidateId: manifest.candidateId,
    assembledAt: options.assembledAt.toISOString(),
    asset,
    manifest: { path: "release-manifest.json", ...(await fileIdentity(manifestPath)) },
  };
  await writeJson(candidateRecordPath, candidate);
  return { candidateRecordPath, executablePath, manifestPath };
}

export async function verifyReleaseCandidate(
  candidatePath: string,
  executablePath: string,
  options: ReleaseVerificationOptions,
): Promise<VerifiedReleaseCandidate> {
  const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as ReleaseCandidate;
  validateCandidateRecord(candidate);

  const candidateDirectory = await realpath(dirname(resolve(candidatePath)));
  const manifestPath = resolve(candidateDirectory, candidate.manifest.path);
  const declaredAssetPath = resolve(candidateDirectory, candidate.asset.path);
  const verifiedManifestPath = await verifyContainedRegularFile(
    candidateDirectory,
    manifestPath,
    "release manifest",
  );
  const verifiedAssetPath = await verifyContainedRegularFile(
    candidateDirectory,
    declaredAssetPath,
    "release asset",
  );
  if (verifiedAssetPath !== (await realpath(executablePath))) {
    throw new Error("Release asset path does not identify the executing candidate.");
  }
  await verifyFile(verifiedManifestPath, candidate.manifest, "release manifest");
  await verifyFile(verifiedAssetPath, candidate.asset, "release asset");

  const manifest = JSON.parse(await readFile(verifiedManifestPath, "utf8")) as ReleaseManifest;
  validateManifest(manifest);
  if (manifest.candidateId !== candidate.candidateId) {
    throw new Error("Release manifest candidate identity does not match the candidate record.");
  }
  if (
    manifest.asset.path !== candidate.asset.path ||
    manifest.asset.size !== candidate.asset.size ||
    manifest.asset.sha256 !== candidate.asset.sha256
  ) {
    throw new Error("Release manifest asset identity does not match the candidate record.");
  }

  verifyDependencyPins(manifest);
  if (options.buildCommit !== manifest.release.commit) {
    throw new Error("Executing asset build commit does not match the candidate source commit.");
  }
  const inspection = await (options.inspectAsset ?? inspectMacAsset)(verifiedAssetPath);
  if (inspection.format !== "mach-o" || inspection.architecture !== "arm64") {
    throw new Error("Release asset is not a native arm64 Mach-O executable.");
  }
  if (manifest.trust.state === "unnotarized" && inspection.signature !== "adhoc") {
    throw new Error("Unnotarized release asset does not have a valid ad-hoc signature.");
  }

  return { candidate, manifest };
}

function validateCandidateRecord(candidate: ReleaseCandidate): void {
  if (candidate.schema !== RELEASE_CANDIDATE_SCHEMA) {
    throw new Error(`Unsupported release candidate schema: ${String(candidate.schema)}`);
  }
  if (typeof candidate.candidateId !== "string" || candidate.candidateId.length === 0) {
    throw new Error("Release candidate identity is missing.");
  }
  if (!isExactTimestamp(candidate.assembledAt)) {
    throw new Error("Release candidate assembly time is malformed.");
  }
  validateFileIdentity(candidate.asset, "release asset");
  validateFileIdentity(candidate.manifest, "release manifest");
}

function validateManifest(manifest: ReleaseManifest): void {
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`Unsupported release manifest schema: ${String(manifest.schema)}`);
  }
  if (
    manifest.release?.product !== "LocalHub" ||
    typeof manifest.release.version !== "string" ||
    manifest.release.version.length === 0 ||
    !/^[0-9a-f]{40}$/.test(manifest.release.commit) ||
    (manifest.release.tag !== null &&
      (typeof manifest.release.tag !== "string" || manifest.release.tag.length === 0))
  ) {
    throw new Error("Release manifest source identity is malformed.");
  }
  const expectedCandidateId = `localhub-${manifest.release.version}-${manifest.release.commit.slice(0, 12)}-darwin-arm64`;
  if (manifest.candidateId !== expectedCandidateId) {
    throw new Error("Release manifest candidate identity is stale or ambiguous.");
  }
  validateFileIdentity(manifest.asset, "manifest asset");
  if (
    manifest.target?.platform !== "darwin" ||
    manifest.target.architecture !== "arm64" ||
    manifest.target.minimumOsVersion !== "15.0" ||
    typeof manifest.target.testedOsVersion !== "string" ||
    manifest.target.testedOsVersion.length === 0
  ) {
    throw new Error("Release manifest target platform is malformed or unsupported.");
  }
  if (manifest.stateSchema !== "localhub-legacy-config/v1") {
    throw new Error("Release state schema does not match the expand-phase contract.");
  }
  if (manifest.rollbackTarget !== `legacy-lh@${manifest.release.version}`) {
    throw new Error("Release rollback target is stale or ambiguous.");
  }
  if (
    manifest.trust?.state === "unnotarized" &&
    manifest.trust.statement !== UNNOTARIZED_TRUST_STATEMENT
  ) {
    throw new Error("Unnotarized release trust wording does not match the settled contract.");
  }
  if (
    manifest.trust?.state === "apple-notarized" &&
    manifest.trust.statement !== APPLE_NOTARIZED_TRUST_STATEMENT
  ) {
    throw new Error("Apple-notarized release trust wording does not match the settled contract.");
  }
  if (manifest.trust?.state === "apple-notarized") {
    throw new Error(
      "Apple-notarized trust is unavailable until notarization proof is implemented.",
    );
  }
  if (manifest.trust?.state !== "unnotarized" && manifest.trust?.state !== "apple-notarized") {
    throw new Error("Release trust state is missing or ambiguous.");
  }
}

function validateFileIdentity(identity: FileIdentity, label: string): void {
  if (
    typeof identity?.path !== "string" ||
    identity.path.length === 0 ||
    !Number.isSafeInteger(identity.size) ||
    identity.size <= 0 ||
    !/^[0-9a-f]{64}$/.test(identity.sha256)
  ) {
    throw new Error(`${label} identity is malformed.`);
  }
}

function isExactTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isInside(directory: string, path: string): boolean {
  const pathFromDirectory = relative(directory, path);
  return (
    pathFromDirectory !== "" &&
    !pathFromDirectory.startsWith("..") &&
    !isAbsolute(pathFromDirectory)
  );
}

async function verifyContainedRegularFile(
  directory: string,
  path: string,
  label: string,
): Promise<string> {
  if (!isInside(directory, path)) {
    throw new Error(`${label} path escapes the assembled candidate.`);
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file.`);
  }
  const resolved = await realpath(path);
  if (!isInside(directory, resolved)) {
    throw new Error(`${label} resolves outside the assembled candidate.`);
  }
  return resolved;
}

async function inspectMacAsset(path: string): Promise<ReleaseAssetInspection> {
  const contents = await readFile(path);
  const isMachO64 = contents.length >= 12 && contents.readUInt32LE(0) === 0xfeedfacf;
  const isArm64 = isMachO64 && contents.readUInt32LE(4) === 0x0100000c;
  if (!isMachO64 || !isArm64) {
    return { format: isMachO64 ? "mach-o" : "other", architecture: "other", signature: "invalid" };
  }
  const verify = Bun.spawn(["codesign", "--verify", "--strict", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await verify.exited) !== 0) {
    return { format: "mach-o", architecture: "arm64", signature: "invalid" };
  }
  const describe = Bun.spawn(["codesign", "-dvvv", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    describe.exited,
    new Response(describe.stdout).text(),
    new Response(describe.stderr).text(),
  ]);
  const description = `${stdout}\n${stderr}`;
  if (code === 0 && description.includes("Signature=adhoc")) {
    return { format: "mach-o", architecture: "arm64", signature: "adhoc" };
  }
  if (code === 0 && description.includes("Authority=Developer ID Application")) {
    return { format: "mach-o", architecture: "arm64", signature: "developer-id" };
  }
  return { format: "mach-o", architecture: "arm64", signature: "invalid" };
}

function verifyDependencyPins(manifest: ReleaseManifest): void {
  if (manifest.dependencies.length !== REQUIRED_DEPENDENCIES.length + 1) {
    throw new Error("Release dependency inventory must contain every settled pin exactly once.");
  }
  const localHub = manifest.dependencies.filter((dependency) => dependency.name === "LocalHub");
  if (
    localHub.length !== 1 ||
    localHub[0]?.version !== manifest.release.version ||
    localHub[0].included !== true ||
    localHub[0].commit !== manifest.release.commit
  ) {
    throw new Error(
      "Release dependency LocalHub must match the included release commit and version.",
    );
  }
  for (const pin of REQUIRED_DEPENDENCIES) {
    const matches = manifest.dependencies.filter((dependency) => dependency.name === pin.name);
    if (matches.length !== 1 || matches[0]?.version !== pin.version) {
      throw new Error(`Release dependency ${pin.name} must be pinned to ${pin.version}.`);
    }
    if (matches[0].included !== pin.included) {
      throw new Error(
        `Release dependency ${pin.name} inclusion must be declared as ${String(pin.included)}.`,
      );
    }
    if ("commit" in pin && matches[0].commit !== pin.commit) {
      throw new Error(`Release dependency ${pin.name} commit does not match the settled pin.`);
    }
    if ("digest" in pin && matches[0].digest !== pin.digest) {
      throw new Error(`Release dependency ${pin.name} digest does not match the settled pin.`);
    }
  }
}

async function verifyFile(path: string, identity: FileIdentity, label: string): Promise<void> {
  const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
  if (metadata.size !== identity.size) {
    throw new Error(`${label} size does not match the candidate record.`);
  }
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== identity.sha256) {
    throw new Error(`${label} checksum does not match the candidate record.`);
  }
}

async function fileIdentity(path: string): Promise<Omit<FileIdentity, "path">> {
  const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    size: metadata.size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}
