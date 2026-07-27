import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { EVIDENCE_SCHEMA } from "../src/evidence.ts";
import {
  RELEASE_CANDIDATE_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  assembleExpandCandidate,
  createExpandReleaseManifest,
  verifyReleaseCandidate,
} from "../src/release.ts";

test("an assembled candidate verifies its exact executable and manifest identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-release-"));
  try {
    const executablePath = join(directory, "lh");
    const manifestPath = join(directory, "release-manifest.json");
    const candidatePath = join(directory, "release-candidate.json");
    await writeFile(executablePath, "assembled-localhub");

    const manifest = releaseManifest(await fileIdentity(executablePath));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const candidate = {
      schema: RELEASE_CANDIDATE_SCHEMA,
      candidateId: manifest.candidateId,
      assembledAt: "2026-07-27T18:00:00.000Z",
      asset: { path: "lh", ...(await fileIdentity(executablePath)) },
      manifest: { path: "release-manifest.json", ...(await fileIdentity(manifestPath)) },
    };
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    const verified = await verifyReleaseCandidate(candidatePath, executablePath);

    expect(verified.candidate.candidateId).toBe("localhub-0.1.1-aaaaaaaaaaaa-darwin-arm64");
    expect(verified.manifest.release.commit).toBe("a".repeat(40));
    expect(verified.manifest.asset.sha256).toBe(candidate.asset.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate verification rejects a substituted release-sensitive dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-release-"));
  try {
    const executablePath = join(directory, "lh");
    const manifestPath = join(directory, "release-manifest.json");
    const candidatePath = join(directory, "release-candidate.json");
    await writeFile(executablePath, "assembled-localhub");

    const manifest = releaseManifest(await fileIdentity(executablePath));
    const llamaCpp = manifest.dependencies.find((dependency) => dependency.name === "llama.cpp");
    if (!llamaCpp) {
      throw new Error("Missing fixture dependency.");
    }
    llamaCpp.digest = `sha256:${"0".repeat(64)}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const candidate = {
      schema: RELEASE_CANDIDATE_SCHEMA,
      candidateId: manifest.candidateId,
      assembledAt: "2026-07-27T18:00:00.000Z",
      asset: { path: "lh", ...(await fileIdentity(executablePath)) },
      manifest: { path: "release-manifest.json", ...(await fileIdentity(manifestPath)) },
    };
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    expect(verifyReleaseCandidate(candidatePath, executablePath)).rejects.toThrow(
      "Release dependency llama.cpp digest does not match the settled pin.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shipped release identity command reports only a verified assembled candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-release-"));
  try {
    const executablePath = join(directory, "lh");
    const manifestPath = join(directory, "release-manifest.json");
    const candidatePath = join(directory, "release-candidate.json");
    await writeFile(executablePath, "assembled-localhub");
    const manifest = releaseManifest(await fileIdentity(executablePath));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      candidatePath,
      `${JSON.stringify(
        {
          schema: RELEASE_CANDIDATE_SCHEMA,
          candidateId: manifest.candidateId,
          assembledAt: "2026-07-27T18:00:00.000Z",
          asset: { path: "lh", ...(await fileIdentity(executablePath)) },
          manifest: { path: "release-manifest.json", ...(await fileIdentity(manifestPath)) },
        },
        null,
        2,
      )}\n`,
    );

    const result = await captureOutput(() =>
      main(["release", "identity", candidatePath], { executablePath }),
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.output.join("\n"))).toMatchObject({
      candidate: { candidateId: manifest.candidateId },
      manifest: { release: { commit: "a".repeat(40) } },
    });
    expect(result.errors).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate verification rejects an ambiguous asset path even when its checksum matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-release-"));
  try {
    const executablePath = join(directory, "lh");
    const manifestPath = join(directory, "release-manifest.json");
    const candidatePath = join(directory, "release-candidate.json");
    await writeFile(executablePath, "assembled-localhub");
    const manifest = releaseManifest(await fileIdentity(executablePath));
    manifest.asset.path = "replacement-lh";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      candidatePath,
      `${JSON.stringify(
        {
          schema: RELEASE_CANDIDATE_SCHEMA,
          candidateId: manifest.candidateId,
          assembledAt: "2026-07-27T18:00:00.000Z",
          asset: { path: "replacement-lh", ...(await fileIdentity(executablePath)) },
          manifest: { path: "release-manifest.json", ...(await fileIdentity(manifestPath)) },
        },
        null,
        2,
      )}\n`,
    );

    expect(verifyReleaseCandidate(candidatePath, executablePath)).rejects.toThrow(
      "Release asset path does not identify the executing candidate.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the expand manifest declares every settled release pin without claiming future runtimes ship", () => {
  const manifest = createExpandReleaseManifest({
    asset: { path: "lh", size: 20, sha256: "1".repeat(64) },
    commit: "a".repeat(40),
    tag: null,
    testedOsVersion: "27.0 (26A5388g)",
    version: "0.1.1",
  });

  expect(manifest).toMatchObject({
    candidateId: `localhub-0.1.1-${"a".repeat(12)}-darwin-arm64`,
    stateSchema: "localhub-legacy-config/v1",
    rollbackTarget: "legacy-lh@0.1.1",
    target: { platform: "darwin", architecture: "arm64", minimumOsVersion: "15.0" },
    trust: { state: "unnotarized" },
  });
  expect(manifest.dependencies).toEqual([
    { name: "LocalHub", version: "0.1.1", included: true, commit: "a".repeat(40) },
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
  ]);
});

test("candidate assembly copies one immutable native asset and writes verifiable sidecars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-assembly-"));
  try {
    const sourceExecutable = join(directory, "built-lh");
    await writeFile(sourceExecutable, "native-assembled-localhub");

    const assembled = await assembleExpandCandidate({
      assembledAt: new Date("2026-07-27T18:00:00.000Z"),
      commit: "a".repeat(40),
      outputDirectory: join(directory, "candidate"),
      sourceExecutable,
      tag: null,
      testedOsVersion: "27.0 (26A5388g)",
      version: "0.1.1",
    });
    const verified = await verifyReleaseCandidate(
      assembled.candidateRecordPath,
      assembled.executablePath,
    );

    expect(verified.candidate.assembledAt).toBe("2026-07-27T18:00:00.000Z");
    expect(await readFile(assembled.executablePath, "utf8")).toBe("native-assembled-localhub");
    expect(verified.manifest.asset.sha256).toBe((await fileIdentity(sourceExecutable)).sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate verification rejects a false trust statement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-trust-"));
  try {
    const sourceExecutable = join(directory, "built-lh");
    await writeFile(sourceExecutable, "native-assembled-localhub");
    const assembled = await assembleExpandCandidate({
      assembledAt: new Date("2026-07-27T18:00:00.000Z"),
      commit: "a".repeat(40),
      outputDirectory: join(directory, "candidate"),
      sourceExecutable,
      tag: null,
      testedOsVersion: "27.0 (26A5388g)",
      version: "0.1.1",
    });
    const manifest = JSON.parse(await readFile(assembled.manifestPath, "utf8"));
    manifest.trust.statement = "Apple reviewed this release.";
    await writeFile(assembled.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const candidate = JSON.parse(await readFile(assembled.candidateRecordPath, "utf8"));
    candidate.manifest = {
      path: "release-manifest.json",
      ...(await fileIdentity(assembled.manifestPath)),
    };
    await writeFile(assembled.candidateRecordPath, `${JSON.stringify(candidate, null, 2)}\n`);

    expect(
      verifyReleaseCandidate(assembled.candidateRecordPath, assembled.executablePath),
    ).rejects.toThrow("Unnotarized release trust wording does not match the settled contract.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shipped evidence command rejects stale, malformed, sensitive, and mismatched records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "localhub-evidence-command-"));
  try {
    const sourceExecutable = join(directory, "built-lh");
    const evidencePath = join(directory, "evidence.json");
    await writeFile(sourceExecutable, "native-assembled-localhub");
    const assembled = await assembleExpandCandidate({
      assembledAt: new Date("2026-07-27T15:00:00.000Z"),
      commit: "a".repeat(40),
      outputDirectory: join(directory, "candidate"),
      sourceExecutable,
      tag: null,
      testedOsVersion: "27.0 (26A5388g)",
      version: "0.1.1",
    });
    const candidate = await verifyReleaseCandidate(
      assembled.candidateRecordPath,
      assembled.executablePath,
    );
    const validRecord = {
      schema: EVIDENCE_SCHEMA,
      evidenceId: "t01-public-negative-test",
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
      },
      gates: [gateRecord()],
    };

    await writeFile(evidencePath, JSON.stringify(validRecord));
    expect(
      (
        await captureOutput(() =>
          main(["evidence", "validate", assembled.candidateRecordPath, evidencePath], {
            executablePath: assembled.executablePath,
          }),
        )
      ).code,
    ).toBe(0);

    const invalidRecords = [
      { ...validRecord, candidate: { ...validRecord.candidate, assetSha256: "3".repeat(64) } },
      { ...validRecord, gates: [{ ...gateRecord(), timestamp: "2026-07-27T14:00:00.000Z" }] },
      { ...validRecord, gates: [{ ...gateRecord(), status: "Ambiguous" }] },
      {
        ...validRecord,
        gates: [{ ...gateRecord(), observed: "Authorization: Bearer private-value" }],
      },
    ];
    for (const invalid of invalidRecords) {
      await writeFile(evidencePath, JSON.stringify(invalid));
      expect(
        (
          await captureOutput(() =>
            main(["evidence", "validate", assembled.candidateRecordPath, evidencePath], {
              executablePath: assembled.executablePath,
            }),
          )
        ).code,
      ).toBe(1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function gateRecord() {
  return {
    journeyGateId: "LH-J1-001",
    requirementIds: ["LH-EVD-003"],
    classification: "Mandatory",
    status: "Passed",
    action: "$CANDIDATE/lh --help",
    expected: "The assembled candidate exposes public help.",
    observed: "The public command matched the expected boundary.",
    artifactLinks: ["https://github.com/scwlkr/LocalHub/actions/runs/1"],
    tester: "LocalHub candidate acceptance driver",
    timestamp: "2026-07-27T16:00:00.000Z",
    priorAttempts: [],
  };
}

function releaseManifest(asset: { size: number; sha256: string }) {
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    candidateId: "localhub-0.1.1-aaaaaaaaaaaa-darwin-arm64",
    release: {
      product: "LocalHub",
      version: "0.1.1",
      commit: "a".repeat(40),
      tag: null,
    },
    asset: { path: "lh", ...asset },
    target: {
      platform: "darwin",
      architecture: "arm64",
      minimumOsVersion: "15.0",
      testedOsVersion: "27.0 (26A5388g)",
    },
    stateSchema: "localhub-legacy-config/v1",
    trust: {
      state: "unnotarized",
      statement:
        "Checksum verified and ad-hoc signed, but not notarized or reviewed by Apple. macOS may block first launch. Use System Settings → Privacy & Security → Open Anyway. Never disable Gatekeeper.",
    },
    rollbackTarget: "legacy-lh@0.1.1",
    dependencies: [
      { name: "LocalHub", version: "0.1.1", included: true, commit: "a".repeat(40) },
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
    ],
  };
}

async function fileIdentity(path: string): Promise<{ size: number; sha256: string }> {
  const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    size: metadata.size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function captureOutput(run: () => Promise<number>): Promise<{
  code: number;
  output: string[];
  errors: string[];
}> {
  const originalLog = console.log;
  const originalError = console.error;
  const output: string[] = [];
  const errors: string[] = [];
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    return { code: await run(), output, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
