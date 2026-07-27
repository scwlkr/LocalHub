import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunFailure } from "./run.ts";
import type { FileIdentity, VerifiedReleaseCandidate } from "./release.ts";
import { isEligibleLanInterface, type PrivateInterface } from "./member-gateway.ts";

export const FIRST_RUN_STATE_SCHEMA = "localhub.first-run-state/v1";
export const FIRST_RUN_STEPS = [
  "trust",
  "host-computer",
  "model-storage",
  "llama-cpp",
  "member-lan",
  "web-search",
  "start-localhub",
  "ready",
] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export interface FirstRunStepState {
  status: "pending" | "passed";
  summary: string | null;
}

export interface FirstRunState {
  schema: typeof FIRST_RUN_STATE_SCHEMA;
  candidateId: string;
  commit: string;
  currentStep: FirstRunStep;
  steps: Record<FirstRunStep, FirstRunStepState>;
  choices: {
    modelStorage: { path: string; freeBytes: number } | null;
    member: {
      interface: PrivateInterface;
      bonjourName: string;
      port: number;
      physicalFriendlyPassed: boolean;
      physicalIpv4Passed: boolean;
    } | null;
    webSearch: "unreviewed" | "disabled";
  };
  runId: string | null;
}

export type FirstRunConfirmation =
  | { step: "trust"; verified: true; summary: string }
  | { step: "host-computer"; report: HostComputerReport }
  | { step: "model-storage"; path: string; freeBytes: number }
  | {
      step: "llama-cpp";
      build: "b10107";
      architecture: "arm64";
      binary: FileIdentity;
      devices: string[];
      emptyRouterProcessLaunch: "passed";
      health: "passed";
      stop: "passed";
      noModelLoaded: true;
      deadlineMs: number;
    }
  | {
      step: "member-lan";
      interface: PrivateInterface;
      bonjourName: string;
      port: number;
      physicalFriendlyPassed: true;
      physicalIpv4Passed: true;
    }
  | { step: "web-search"; choice: "disabled" }
  | { step: "start-localhub"; runId: string; running: true; memberLinkOpen: true }
  | { step: "ready"; dashboardOpened: true; sharedModelAvailable: false };

export interface HostComputerObservation {
  platform: NodeJS.Platform;
  architecture: string;
  osVersion: string;
  freeBytes: number;
  interfaces: PrivateInterface[];
  firewall: { enabled: boolean; blockAll: boolean; localHubAllowed: boolean | null };
  sleep: { wakeForNetworkAccess: boolean };
}

export interface HostComputerResult {
  name: string;
  status: "passed" | "warning" | "failed";
  detail: string;
}

export interface HostComputerReport {
  passed: boolean;
  results: HostComputerResult[];
  privateInterfaces: PrivateInterface[];
  failure: RunFailure | null;
}

const EFFECTS: Record<FirstRunStep, { effect: string; protected: string; recovery: string }> = {
  trust: {
    effect: "Verify this exact release before any LocalHub process starts.",
    protected: "No Run, network listener, model transfer, or background action exists yet.",
    recovery: "Quit safely; verify or replace only the exact release candidate, then recheck.",
  },
  "host-computer": {
    effect: "Read Apple Silicon, macOS, storage, network, firewall, and sleep results.",
    protected: "Failed boundaries stay closed while the local verification screen remains usable.",
    recovery: "Repair the named failed result and explicitly recheck Host Computer.",
  },
  "model-storage": {
    effect: "Create LocalHub-managed catalog and staging space only in the confirmed folder.",
    protected: "Existing files and original model sources remain untouched.",
    recovery: "Choose an available writable folder or reconnect the selected drive, then recheck.",
  },
  "llama-cpp": {
    effect: "Run one finite loopback-only load, health, device, and stop verification.",
    protected: "No model or profile is loaded and no alternate runtime is searched.",
    recovery: "Repair the exact pinned runtime in this candidate, then explicitly recheck.",
  },
  "member-lan": {
    effect:
      "Temporarily listen only on the selected private interface and verify both displayed links.",
    protected:
      "Host control stays loopback-only; a failed Member check closes the Member listener.",
    recovery: "Repair the named interface, firewall, mDNS, or peer-isolation cause, then recheck.",
  },
  "web-search": {
    effect: "Leave optional Web Search disabled in this candidate.",
    protected:
      "No image pull, account, trial, paid endpoint, public instance, or fallback is used.",
    recovery: "Continue without Web Search.",
  },
  "start-localhub": {
    effect: "Start the exact verified Run and open the selected-interface Member Link.",
    protected: "Nothing starts until the explicit Start LocalHub confirmation.",
    recovery: "Fix the named failure and explicitly choose Start LocalHub again.",
  },
  ready: {
    effect: "Open the loopback Host dashboard.",
    protected: "Members cannot infer until an exact acquired, tested, shared model passes.",
    recovery: "Use Stop LocalHub to close the Member Link and owned processes.",
  },
};

export function createFirstRunState(candidate: VerifiedReleaseCandidate): FirstRunState {
  return {
    schema: FIRST_RUN_STATE_SCHEMA,
    candidateId: candidate.candidate.candidateId,
    commit: candidate.manifest.release.commit,
    currentStep: "trust",
    steps: Object.fromEntries(
      FIRST_RUN_STEPS.map((step) => [step, { status: "pending", summary: null }]),
    ) as Record<FirstRunStep, FirstRunStepState>,
    choices: { modelStorage: null, member: null, webSearch: "unreviewed" },
    runId: null,
  };
}

export async function readFirstRunState(
  path: string,
  candidate: VerifiedReleaseCandidate,
): Promise<FirstRunState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!isFirstRunState(parsed)) {
    throw new Error("Saved First Run state is incomplete or malformed.");
  }
  if (
    parsed.candidateId !== candidate.candidate.candidateId ||
    parsed.commit !== candidate.manifest.release.commit
  ) {
    throw new Error(
      "Saved First Run choices belong to a different release candidate and cannot be resumed.",
    );
  }
  return parsed;
}

export async function writeFirstRunState(path: string, state: FirstRunState): Promise<void> {
  if (!isFirstRunState(state)) throw new Error("First Run state is incomplete or malformed.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

export function advanceFirstRun(
  state: FirstRunState,
  confirmation: FirstRunConfirmation,
): FirstRunState {
  if (confirmation.step !== state.currentStep) {
    throw new Error(
      `Guided Runway must complete ${state.currentStep} before ${confirmation.step}. No background action was performed.`,
    );
  }
  let summary: string;
  const next = structuredClone(state);
  switch (confirmation.step) {
    case "trust":
      summary = confirmation.summary;
      break;
    case "host-computer":
      if (!confirmation.report.passed) throw new Error("Host Computer checks have not passed.");
      summary = confirmation.report.results
        .map((item) => `${item.name}: ${item.detail}`)
        .join("; ");
      break;
    case "model-storage":
      if (!confirmation.path || confirmation.freeBytes < 0) {
        throw new Error("Model Storage must be an available confirmed location.");
      }
      next.choices.modelStorage = {
        path: confirmation.path,
        freeBytes: confirmation.freeBytes,
      };
      summary = `Confirmed Model Storage with ${confirmation.freeBytes} bytes free.`;
      break;
    case "llama-cpp":
      if (confirmation.devices.length === 0 || confirmation.deadlineMs <= 0) {
        throw new Error("Pinned llama.cpp verification did not return an exact finite result.");
      }
      summary = `Pinned ${confirmation.build} ${confirmation.architecture} binary ${confirmation.binary.path} (${confirmation.binary.size} bytes, sha256:${confirmation.binary.sha256}); ${confirmation.devices.join(", ")}; loopback-only empty-router process launch (no model loaded), health, and stop passed within ${confirmation.deadlineMs} ms.`;
      break;
    case "member-lan":
      if (!isEligibleLanInterface(confirmation.interface)) {
        throw new Error("Member readiness requires the selected RFC 1918 non-VPN LAN interface.");
      }
      next.choices.member = {
        interface: confirmation.interface,
        bonjourName: confirmation.bonjourName,
        port: confirmation.port,
        physicalFriendlyPassed: confirmation.physicalFriendlyPassed,
        physicalIpv4Passed: confirmation.physicalIpv4Passed,
      };
      summary = "Physical Member opened the exact friendly and IPv4 fallback links.";
      break;
    case "web-search":
      next.choices.webSearch = confirmation.choice;
      summary = "Web Search disabled; no fallback or external action.";
      break;
    case "start-localhub":
      if (!confirmation.runId) throw new Error("Ready requires one exact running LocalHub Run.");
      next.runId = confirmation.runId;
      summary = "Explicit Start LocalHub completed; selected Member Link is open.";
      break;
    case "ready":
      summary =
        "Host dashboard opened; a passing Shared Model is still required before inference is available.";
      break;
  }
  next.steps[confirmation.step] = { status: "passed", summary };
  const currentIndex = FIRST_RUN_STEPS.indexOf(confirmation.step);
  next.currentStep =
    FIRST_RUN_STEPS[Math.min(currentIndex + 1, FIRST_RUN_STEPS.length - 1)] ?? "ready";
  return next;
}

export function rewindFirstRunForMemberSelection(state: FirstRunState): FirstRunState {
  if (state.currentStep !== "start-localhub" || state.runId !== null) {
    throw new Error("Member selection can rewind only before a LocalHub Run has started.");
  }
  const next = structuredClone(state);
  const memberIndex = FIRST_RUN_STEPS.indexOf("member-lan");
  for (const step of FIRST_RUN_STEPS.slice(memberIndex)) {
    next.steps[step] = { status: "pending", summary: null };
  }
  next.currentStep = "member-lan";
  next.choices.member = null;
  next.choices.webSearch = "unreviewed";
  next.runId = null;
  return next;
}

export function renderGuidedRunway(
  state: FirstRunState,
  candidate: VerifiedReleaseCandidate,
): string {
  if (
    state.candidateId !== candidate.candidate.candidateId ||
    state.commit !== candidate.manifest.release.commit
  ) {
    throw new Error("Saved First Run choices belong to a different release candidate.");
  }
  const route = FIRST_RUN_STEPS.map((step) => {
    const marker =
      state.steps[step].status === "passed" ? "✓" : step === state.currentStep ? "→" : "·";
    return `${marker} ${routeLabel(step)}`;
  }).join("\n");
  const effect = EFFECTS[state.currentStep];
  const trust =
    state.currentStep === "trust"
      ? `\n${candidate.manifest.trust.state === "apple-notarized" ? "Apple-notarized release" : "Unnotarized release"}\n${candidate.manifest.trust.statement}\n`
      : "";
  return `Guided Runway\n${route}\n${trust}\nWhat changes now\n${effect.effect}\nProtected state: ${effect.protected}\nRecovery: ${effect.recovery}`;
}

export function evaluateHostComputer(observation: HostComputerObservation): HostComputerReport {
  const privateInterfaces = observation.interfaces.filter(isEligibleLanInterface);
  const results: HostComputerResult[] = [
    {
      name: "Apple Silicon",
      status:
        observation.platform === "darwin" && observation.architecture === "arm64"
          ? "passed"
          : "failed",
      detail: `${observation.platform} ${observation.architecture}`,
    },
    {
      name: "Supported macOS",
      status:
        observation.platform === "darwin" && supportedMacOs(observation.osVersion)
          ? "passed"
          : "failed",
      detail: observation.osVersion,
    },
    {
      name: "Free space",
      status: observation.freeBytes >= 1_073_741_824 ? "passed" : "failed",
      detail: `${observation.freeBytes} bytes available`,
    },
    {
      name: "Private interface",
      status: privateInterfaces.length > 0 ? "passed" : "failed",
      detail:
        privateInterfaces.length > 0
          ? privateInterfaces.map((item) => `${item.name} ${item.address}`).join(", ")
          : "No selected-interface-ready RFC 1918 IPv4 address",
    },
    {
      name: "Firewall",
      status: observation.firewall.blockAll
        ? "failed"
        : observation.firewall.enabled
          ? "warning"
          : "warning",
      detail: observation.firewall.blockAll
        ? "Block all incoming connections is enabled"
        : observation.firewall.localHubAllowed === true
          ? "LocalHub is allowed"
          : "Physical Member readiness must prove incoming access",
    },
    {
      name: "Sleep",
      status: "warning",
      detail: observation.sleep.wakeForNetworkAccess
        ? "Wake for network access is enabled but availability is not guaranteed"
        : "A sleeping Host is offline; wake and network boundaries require recheck",
    },
  ];
  const passed = !results.some((item) => item.status === "failed");
  return {
    passed,
    results,
    privateInterfaces,
    failure: passed
      ? null
      : {
          cause: results
            .filter((item) => item.status === "failed")
            .map((item) => `${item.name}: ${item.detail}`)
            .join("; "),
          protectedState:
            "The Member gateway remains closed and no LocalHub Run, model, source, or external service changed.",
          stillWorks: "Release trust and unaffected Host checks remain visible.",
          repair:
            "Repair the named Host boundary without bypassing macOS security or network controls.",
          recheck: "Run the Host Computer check again.",
        },
  };
}

function supportedMacOs(version: string): boolean {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= 15;
}

function routeLabel(step: FirstRunStep): string {
  switch (step) {
    case "trust":
      return "Release trust";
    case "host-computer":
      return "Host Computer";
    case "model-storage":
      return "Model Storage";
    case "llama-cpp":
      return "Pinned llama.cpp";
    case "member-lan":
      return "Member LAN readiness";
    case "web-search":
      return "Optional Web Search";
    case "start-localhub":
      return "Start LocalHub";
    case "ready":
      return "Ready";
  }
}

function isFirstRunState(value: unknown): value is FirstRunState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<FirstRunState>;
  if (
    state.schema !== FIRST_RUN_STATE_SCHEMA ||
    typeof state.candidateId !== "string" ||
    !/^[0-9a-f]{40}$/.test(state.commit ?? "") ||
    !FIRST_RUN_STEPS.includes(state.currentStep as FirstRunStep) ||
    typeof state.steps !== "object" ||
    state.steps === null ||
    typeof state.choices !== "object" ||
    state.choices === null ||
    (state.runId !== null && typeof state.runId !== "string")
  ) {
    return false;
  }
  for (const step of FIRST_RUN_STEPS) {
    const record = state.steps[step];
    if (
      !record ||
      (record.status !== "pending" && record.status !== "passed") ||
      (record.status === "passed"
        ? typeof record.summary !== "string" || record.summary.length === 0
        : record.summary !== null)
    ) {
      return false;
    }
  }
  const currentIndex = FIRST_RUN_STEPS.indexOf(state.currentStep as FirstRunStep);
  for (const [index, step] of FIRST_RUN_STEPS.entries()) {
    const status = state.steps[step]?.status;
    const expected = index < currentIndex ? "passed" : "pending";
    if (state.currentStep === "ready" && step === "ready") {
      if (status !== "pending" && status !== "passed") return false;
    } else if (status !== expected) {
      return false;
    }
  }
  const choices = state.choices;
  const modelStoragePassed = state.steps["model-storage"]?.status === "passed";
  const memberPassed = state.steps["member-lan"]?.status === "passed";
  const webSearchPassed = state.steps["web-search"]?.status === "passed";
  const startPassed = state.steps["start-localhub"]?.status === "passed";
  if (
    (choices.webSearch !== "unreviewed" && choices.webSearch !== "disabled") ||
    (webSearchPassed ? choices.webSearch !== "disabled" : choices.webSearch !== "unreviewed") ||
    (choices.modelStorage !== null &&
      (typeof choices.modelStorage?.path !== "string" ||
        choices.modelStorage.path.length === 0 ||
        !Number.isSafeInteger(choices.modelStorage.freeBytes) ||
        choices.modelStorage.freeBytes < 0)) ||
    modelStoragePassed !== (choices.modelStorage !== null) ||
    (choices.member !== null &&
      (typeof choices.member?.interface?.name !== "string" ||
        !isEligibleLanInterface(choices.member.interface) ||
        typeof choices.member.interface.netmask !== "string" ||
        typeof choices.member.bonjourName !== "string" ||
        !Number.isInteger(choices.member.port) ||
        choices.member.port < 1024 ||
        choices.member.port > 65535 ||
        choices.member.physicalFriendlyPassed !== true ||
        choices.member.physicalIpv4Passed !== true)) ||
    memberPassed !== (choices.member !== null) ||
    startPassed !== (typeof state.runId === "string" && state.runId.length > 0)
  ) {
    return false;
  }
  return true;
}
