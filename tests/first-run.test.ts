import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APPLE_NOTARIZED_TRUST_STATEMENT,
  RELEASE_CANDIDATE_SCHEMA,
  RELEASE_MANIFEST_SCHEMA,
  UNNOTARIZED_TRUST_STATEMENT,
  type VerifiedReleaseCandidate,
} from "../src/release.ts";
import {
  advanceFirstRun,
  createFirstRunState,
  evaluateHostComputer,
  readFirstRunState,
  renderGuidedRunway,
  writeFirstRunState,
} from "../src/first-run.ts";
import { runGuidedFirstRun, type GuidedRunwayIO } from "../src/guided-runway.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("Guided Runway advances only in the accepted order and shows the current effect", () => {
  const candidate = verifiedCandidate("unnotarized");
  const initial = createFirstRunState(candidate);

  expect(initial.currentStep).toBe("trust");
  expect(renderGuidedRunway(initial, candidate)).toContain("What changes now");
  expect(renderGuidedRunway(initial, candidate)).toContain(UNNOTARIZED_TRUST_STATEMENT);
  expect(() =>
    advanceFirstRun(initial, {
      step: "model-storage",
      path: "/Volumes/Test/Models",
      freeBytes: 80_000_000_000,
    }),
  ).toThrow("trust");

  const trust = advanceFirstRun(initial, {
    step: "trust",
    verified: true,
    summary: "Exact candidate, manifest, architecture, checksums, tree, and signature passed.",
  });
  expect(trust.currentStep).toBe("host-computer");
  expect(trust.steps.trust.status).toBe("passed");
  expect(JSON.stringify(trust)).not.toContain("password");
  expect(JSON.stringify(trust)).not.toContain("token");
});

test("First Run resumes only non-secret choices for the exact candidate", async () => {
  const root = await isolatedRoot();
  const path = join(root, "first-run-state.json");
  const candidate = verifiedCandidate("unnotarized");
  const state = advanceFirstRun(createFirstRunState(candidate), {
    step: "trust",
    verified: true,
    summary: "Exact release trust passed.",
  });
  await writeFirstRunState(path, state);

  expect(await readFirstRunState(path, candidate)).toEqual(state);
  const serialized = await readFile(path, "utf8");
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain("credential");

  const other = verifiedCandidate("unnotarized");
  other.candidate.candidateId = "localhub-0.1.1-bbbbbbbbbbbb-darwin-arm64";
  other.manifest.candidateId = other.candidate.candidateId;
  await expect(readFirstRunState(path, other)).rejects.toThrow("different release candidate");
});

test("First Run rejects a persisted route that skips required confirmed steps", async () => {
  const root = await isolatedRoot();
  const path = join(root, "first-run-state.json");
  const candidate = verifiedCandidate("unnotarized");
  const state = createFirstRunState(candidate);
  state.currentStep = "ready";
  state.runId = "forged-run";
  await writeFile(path, JSON.stringify(state));

  await expect(readFirstRunState(path, candidate)).rejects.toThrow("malformed");
});

test("both exact release trust statements remain visible without a bypass", () => {
  const notarized = verifiedCandidate("apple-notarized");
  const unnotarized = verifiedCandidate("unnotarized");

  expect(renderGuidedRunway(createFirstRunState(notarized), notarized)).toContain(
    APPLE_NOTARIZED_TRUST_STATEMENT,
  );
  const fallback = renderGuidedRunway(createFirstRunState(unnotarized), unnotarized);
  expect(fallback).toContain(UNNOTARIZED_TRUST_STATEMENT);
  expect(fallback).not.toContain("xattr");
  expect(fallback).not.toContain("spctl --disable");
});

test("Host checks fail closed on wrong architecture and unavailable private interfaces", () => {
  const report = evaluateHostComputer({
    platform: "darwin",
    architecture: "x64",
    osVersion: "27.0",
    freeBytes: 500_000_000_000,
    interfaces: [{ name: "en0", address: "203.0.113.8", netmask: "255.255.255.0" }],
    firewall: { enabled: true, blockAll: false, localHubAllowed: null },
    sleep: { wakeForNetworkAccess: false },
  });

  expect(report.passed).toBe(false);
  expect(report.results.find((item) => item.name === "Apple Silicon")?.status).toBe("failed");
  expect(report.results.find((item) => item.name === "Private interface")?.status).toBe("failed");
  expect(report.failure).toMatchObject({
    protectedState: expect.stringContaining("Member gateway remains closed"),
    repair: expect.any(String),
    recheck: expect.any(String),
  });
});

test("Host checks fail closed when the firewall blocks all incoming Member access", () => {
  const report = evaluateHostComputer({
    platform: "darwin",
    architecture: "arm64",
    osVersion: "27.0",
    freeBytes: 500_000_000_000,
    interfaces: [{ name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" }],
    firewall: { enabled: true, blockAll: true, localHubAllowed: false },
    sleep: { wakeForNetworkAccess: false },
  });

  expect(report.passed).toBe(false);
  expect(report.results.find((item) => item.name === "Firewall")).toMatchObject({
    status: "failed",
    detail: expect.stringContaining("Block all"),
  });
  expect(report.failure).toMatchObject({
    protectedState: expect.stringContaining("Member gateway remains closed"),
    repair: expect.any(String),
    recheck: expect.any(String),
  });
});

test("Guided Runway performs each approved action once and reaches honest Ready", async () => {
  const root = await isolatedRoot();
  const candidate = verifiedCandidate("unnotarized");
  const selected = { name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" };
  const io = new ScriptedIO(["y", "y", "/test/models", "y", "y", "1", "y", "y", "Start LocalHub"]);
  const operations: string[] = [];

  const result = await runGuidedFirstRun(
    {
      candidate,
      defaultModelStorage: "/test/default-models",
      statePath: join(root, "first-run-state.json"),
    },
    {
      io,
      observeHost: async () => {
        operations.push("host");
        return {
          platform: "darwin",
          architecture: "arm64",
          osVersion: "27.0",
          freeBytes: 500_000_000_000,
          interfaces: [selected],
          firewall: { enabled: true, blockAll: false, localHubAllowed: null },
          sleep: { wakeForNetworkAccess: false },
        };
      },
      prepareModelStorage: async (path) => {
        operations.push(`storage:${path}`);
        return { path, freeBytes: 400_000_000_000 };
      },
      verifyRuntime: async () => {
        operations.push("runtime");
        return {
          build: "b10107",
          architecture: "arm64",
          binary: {
            path: "runtime/llama.cpp/llama-server",
            size: 100,
            sha256: "3".repeat(64),
          },
          devices: ["Metal: test device"],
          emptyRouterProcessLaunch: "passed",
          health: "passed",
          stop: "passed",
          noModelLoaded: true,
          deadlineMs: 30_000,
        };
      },
      currentInterfaces: () => [
        { name: "en9", address: "203.0.113.8", netmask: "255.255.255.0" },
        selected,
      ],
      resolveBonjourName: async () => "localhub-test.local",
      verifyPhysicalMember: async (binding) => {
        operations.push(`member:${binding.interface.name}`);
        return { physicalFriendlyPassed: true, physicalIpv4Passed: true };
      },
      startRun: async (modelsDirectory, member) => {
        operations.push(`start:${modelsDirectory}:${member.interface.name}`);
        return { runId: "run-identity", hostOrigin: "http://127.0.0.1:39281" };
      },
      inspectRun: async () => {
        throw new Error("fresh path must not inspect");
      },
      openDashboard: async () => {
        operations.push("open");
      },
    },
  );

  expect(result.kind).toBe("ready");
  expect(result.state.currentStep).toBe("ready");
  expect(result.state.steps.ready.status).toBe("passed");
  expect(operations).toEqual([
    "host",
    "storage:/test/models",
    "runtime",
    "member:en0",
    "start:/test/models:en0",
    "open",
  ]);
  expect(io.output.join("\n")).toContain("passing Shared Model is still required");
  expect(result.state.steps["llama-cpp"].summary).toContain("runtime/llama.cpp/llama-server");
  expect(io.output.join("\n")).not.toContain("203.0.113.8");
});

test("a stale confirmed Member interface rewinds only Member and downstream steps", async () => {
  const root = await isolatedRoot();
  const candidate = verifiedCandidate("unnotarized");
  const oldInterface = {
    name: "en0",
    address: "192.168.50.20",
    netmask: "255.255.255.0",
  };
  const newInterface = {
    name: "en1",
    address: "192.168.60.20",
    netmask: "255.255.255.0",
  };
  let state = createFirstRunState(candidate);
  state = advanceFirstRun(state, {
    step: "trust",
    verified: true,
    summary: "Exact release trust passed.",
  });
  state = advanceFirstRun(state, {
    step: "host-computer",
    report: evaluateHostComputer({
      platform: "darwin",
      architecture: "arm64",
      osVersion: "27.0",
      freeBytes: 500_000_000_000,
      interfaces: [oldInterface],
      firewall: { enabled: true, blockAll: false, localHubAllowed: null },
      sleep: { wakeForNetworkAccess: false },
    }),
  });
  state = advanceFirstRun(state, {
    step: "model-storage",
    path: "/test/models",
    freeBytes: 400_000_000_000,
  });
  state = advanceFirstRun(state, {
    step: "llama-cpp",
    build: "b10107",
    architecture: "arm64",
    binary: { path: "runtime/llama.cpp/llama-server", size: 100, sha256: "3".repeat(64) },
    devices: ["Metal: test device"],
    emptyRouterProcessLaunch: "passed",
    health: "passed",
    stop: "passed",
    noModelLoaded: true,
    deadlineMs: 30_000,
  });
  state = advanceFirstRun(state, {
    step: "member-lan",
    interface: oldInterface,
    bonjourName: "localhub-test.local",
    port: 39283,
    physicalFriendlyPassed: true,
    physicalIpv4Passed: true,
  });
  state = advanceFirstRun(state, { step: "web-search", choice: "disabled" });
  const safeSummaries = {
    trust: state.steps.trust.summary,
    host: state.steps["host-computer"].summary,
    storage: state.steps["model-storage"].summary,
    runtime: state.steps["llama-cpp"].summary,
  };
  const statePath = join(root, "first-run-state.json");
  await writeFirstRunState(statePath, state);
  const io = new ScriptedIO(["Start LocalHub", "1", "y", "y", "Start LocalHub"]);
  const operations: string[] = [];

  const result = await runGuidedFirstRun(
    { candidate, defaultModelStorage: "/unused", statePath },
    {
      io,
      observeHost: async () => {
        throw new Error("must preserve confirmed Host checks");
      },
      prepareModelStorage: async () => {
        throw new Error("must preserve confirmed Model Storage");
      },
      verifyRuntime: async () => {
        throw new Error("must preserve confirmed runtime proof");
      },
      currentInterfaces: () => [newInterface],
      resolveBonjourName: async () => "localhub-new.local",
      verifyPhysicalMember: async (binding) => {
        operations.push(`member:${binding.interface.name}`);
        return { physicalFriendlyPassed: true, physicalIpv4Passed: true };
      },
      startRun: async (_modelsDirectory, member) => {
        operations.push(`start:${member.interface.name}`);
        return { runId: "fresh-run", hostOrigin: "http://127.0.0.1:39281" };
      },
      inspectRun: async () => {
        throw new Error("fresh path must not inspect");
      },
      openDashboard: async () => {
        operations.push("open");
      },
    },
  );

  expect(result.kind).toBe("ready");
  expect(result.state.choices.modelStorage?.path).toBe("/test/models");
  expect(result.state.choices.member?.interface).toEqual(newInterface);
  expect(result.state.steps.trust.summary).toBe(safeSummaries.trust);
  expect(result.state.steps["host-computer"].summary).toBe(safeSummaries.host);
  expect(result.state.steps["model-storage"].summary).toBe(safeSummaries.storage);
  expect(result.state.steps["llama-cpp"].summary).toBe(safeSummaries.runtime);
  expect(operations).toEqual(["member:en1", "start:en1", "open"]);
  expect(io.output.join("\n")).toMatch(
    /Cause:.*confirmed Member interface changed.*Protected state:.*Still works:.*Repair:.*Recheck:/,
  );
});

test("unavailable storage reports cause, protected state, one repair, and recheck", async () => {
  const root = await isolatedRoot();
  const candidate = verifiedCandidate("unnotarized");
  let state = createFirstRunState(candidate);
  state = advanceFirstRun(state, {
    step: "trust",
    verified: true,
    summary: "Exact release trust passed.",
  });
  state = advanceFirstRun(state, {
    step: "host-computer",
    report: evaluateHostComputer({
      platform: "darwin",
      architecture: "arm64",
      osVersion: "27.0",
      freeBytes: 500_000_000_000,
      interfaces: [{ name: "en0", address: "192.168.50.20", netmask: "255.255.255.0" }],
      firewall: { enabled: true, blockAll: false, localHubAllowed: null },
      sleep: { wakeForNetworkAccess: false },
    }),
  });
  const statePath = join(root, "first-run-state.json");
  await writeFirstRunState(statePath, state);

  await expect(
    runGuidedFirstRun(
      { candidate, defaultModelStorage: "/unavailable", statePath },
      {
        io: new ScriptedIO(["/unavailable", "y"]),
        observeHost: async () => {
          throw new Error("must not rerun completed Host checks");
        },
        prepareModelStorage: async () => {
          throw new Error("selected storage is unavailable");
        },
        verifyRuntime: async () => {
          throw new Error("must not run");
        },
        currentInterfaces: () => [],
        resolveBonjourName: async () => {
          throw new Error("must not run");
        },
        verifyPhysicalMember: async () => {
          throw new Error("must not run");
        },
        startRun: async () => {
          throw new Error("must not run");
        },
        inspectRun: async () => {
          throw new Error("must not run");
        },
        openDashboard: async () => {
          throw new Error("must not run");
        },
      },
    ),
  ).rejects.toThrow(
    /Cause:.*selected storage is unavailable.*Protected state:.*Still works:.*Repair:.*Recheck:/,
  );
});

test("quitting before trust approval performs no Host, storage, runtime, network, or start action", async () => {
  const root = await isolatedRoot();
  const operations: string[] = [];
  const result = await runGuidedFirstRun(
    {
      candidate: verifiedCandidate("unnotarized"),
      defaultModelStorage: "/test/default-models",
      statePath: join(root, "first-run-state.json"),
    },
    {
      io: new ScriptedIO(["q"]),
      observeHost: async () => {
        operations.push("host");
        throw new Error("must not run");
      },
      prepareModelStorage: async () => {
        operations.push("storage");
        throw new Error("must not run");
      },
      verifyRuntime: async () => {
        operations.push("runtime");
        throw new Error("must not run");
      },
      currentInterfaces: () => [],
      resolveBonjourName: async () => {
        operations.push("bonjour");
        return "localhub-test.local";
      },
      verifyPhysicalMember: async () => {
        operations.push("member");
        return { physicalFriendlyPassed: true, physicalIpv4Passed: true };
      },
      startRun: async () => {
        operations.push("start");
        return { runId: "unexpected", hostOrigin: "http://127.0.0.1:39281" };
      },
      inspectRun: async () => {
        operations.push("inspect");
        throw new Error("must not run");
      },
      openDashboard: async () => {
        operations.push("open");
      },
    },
  );

  expect(result.kind).toBe("cancelled");
  expect(operations).toEqual([]);
});

function verifiedCandidate(
  trustState: "apple-notarized" | "unnotarized",
): VerifiedReleaseCandidate {
  const asset = { path: "lh", size: 20, sha256: "1".repeat(64) };
  return {
    candidate: {
      schema: RELEASE_CANDIDATE_SCHEMA,
      candidateId: "localhub-0.1.1-aaaaaaaaaaaa-darwin-arm64",
      assembledAt: "2026-07-27T18:00:00.000Z",
      asset,
      manifest: { path: "release-manifest.json", size: 100, sha256: "2".repeat(64) },
    },
    manifest: {
      schema: RELEASE_MANIFEST_SCHEMA,
      candidateId: "localhub-0.1.1-aaaaaaaaaaaa-darwin-arm64",
      release: { product: "LocalHub", version: "0.1.1", commit: "a".repeat(40), tag: null },
      asset,
      target: {
        platform: "darwin",
        architecture: "arm64",
        minimumOsVersion: "15.0",
        testedOsVersion: "27.0",
      },
      stateSchema: "localhub-legacy-config/v1",
      trust: {
        state: trustState,
        statement:
          trustState === "apple-notarized"
            ? APPLE_NOTARIZED_TRUST_STATEMENT
            : UNNOTARIZED_TRUST_STATEMENT,
      },
      rollbackTarget: "legacy-lh@0.1.1",
      runtime: null,
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

async function isolatedRoot(): Promise<string> {
  const parent = join(process.cwd(), "dist", "test-tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "first-run-"));
  roots.push(root);
  return root;
}

class ScriptedIO implements GuidedRunwayIO {
  readonly output: string[] = [];

  constructor(private readonly answers: string[]) {}

  print(message = ""): void {
    this.output.push(message);
  }

  async ask(prompt: string): Promise<string> {
    this.output.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`No scripted answer for ${prompt}`);
    return answer;
  }
}
