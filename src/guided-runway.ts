import {
  advanceFirstRun,
  createFirstRunState,
  evaluateHostComputer,
  readFirstRunState,
  renderGuidedRunway,
  writeFirstRunState,
  type FirstRunState,
  type HostComputerObservation,
} from "./first-run.ts";
import {
  createMemberBinding,
  type MemberBinding,
  type PrivateInterface,
} from "./member-gateway.ts";
import type { VerifiedReleaseCandidate } from "./release.ts";

export interface GuidedRunwayIO {
  print(message?: string): void;
  ask(prompt: string): Promise<string>;
}

export interface GuidedFirstRunOptions {
  candidate: VerifiedReleaseCandidate;
  defaultModelStorage: string;
  statePath: string;
  memberPort?: number;
}

export interface GuidedRuntimeResult {
  build: "b10107";
  architecture: "arm64";
  devices: string[];
  emptyRouterProcessLaunch: "passed";
  health: "passed";
  stop: "passed";
  noModelLoaded: true;
  deadlineMs: number;
}

export interface GuidedFirstRunDependencies {
  io: GuidedRunwayIO;
  observeHost(): Promise<HostComputerObservation>;
  prepareModelStorage(path: string): Promise<{ path: string; freeBytes: number }>;
  verifyRuntime(modelStorage: string): Promise<GuidedRuntimeResult>;
  currentInterfaces(): PrivateInterface[];
  resolveBonjourName(): Promise<string>;
  verifyPhysicalMember(binding: MemberBinding): Promise<{
    physicalFriendlyPassed: boolean;
    physicalIpv4Passed: boolean;
  }>;
  startRun(
    modelsDirectory: string,
    member: MemberBinding,
  ): Promise<{ runId: string; hostOrigin: string }>;
  inspectRun(runId: string): Promise<{ runId: string; hostOrigin: string; memberReady: boolean }>;
  openDashboard(origin: string): Promise<void>;
}

export type GuidedFirstRunResult =
  | { kind: "cancelled"; state: FirstRunState }
  | { kind: "ready"; state: FirstRunState; hostOrigin: string };

export async function runGuidedFirstRun(
  options: GuidedFirstRunOptions,
  dependencies: GuidedFirstRunDependencies,
): Promise<GuidedFirstRunResult> {
  let state =
    (await readFirstRunState(options.statePath, options.candidate)) ??
    createFirstRunState(options.candidate);
  let hostOrigin: string | null = null;

  while (true) {
    dependencies.io.print(renderGuidedRunway(state, options.candidate));
    switch (state.currentStep) {
      case "trust": {
        if (
          !(await approved(dependencies.io, "Continue with this exact verified release? [y/q] "))
        ) {
          return { kind: "cancelled", state };
        }
        state = advanceFirstRun(state, {
          step: "trust",
          verified: true,
          summary:
            "Exact candidate, exhaustive manifest, architecture, checksums, tree, and declared signature passed.",
        });
        break;
      }
      case "host-computer": {
        const observation = await protectedStep(
          dependencies.observeHost,
          "Host Computer check",
          "No Run or Member listener started and no setting was changed.",
          "Restore the supported Host-check command boundary.",
          "Rerun Host Computer check.",
        );
        const report = evaluateHostComputer(observation);
        for (const result of report.results) {
          dependencies.io.print(
            `${result.status.toUpperCase()} — ${result.name}: ${result.detail}`,
          );
        }
        if (!report.passed) throw new Error(formatFailure(report.failure));
        if (!(await approved(dependencies.io, "Continue with these exact Host results? [y/q] "))) {
          return { kind: "cancelled", state };
        }
        state = advanceFirstRun(state, { step: "host-computer", report });
        break;
      }
      case "model-storage": {
        const answer = (
          await dependencies.io.ask(
            `Model Storage folder [${options.defaultModelStorage}] (q to quit): `,
          )
        ).trim();
        if (answer.toLowerCase() === "q") return { kind: "cancelled", state };
        const path = answer || options.defaultModelStorage;
        dependencies.io.print(
          `Only LocalHub-managed catalog and staging directories will be created inside ${path}. Existing files and outside sources remain untouched.`,
        );
        if (!(await approved(dependencies.io, "Confirm this Model Storage? [y/q] "))) {
          return { kind: "cancelled", state };
        }
        const storage = await protectedStep(
          () => dependencies.prepareModelStorage(path),
          "Model Storage confirmation",
          "No Run started; existing files and every outside source remain untouched.",
          "Reconnect or choose one available writable folder with enough space.",
          "Rerun Model Storage confirmation.",
        );
        state = advanceFirstRun(state, { step: "model-storage", ...storage });
        break;
      }
      case "llama-cpp": {
        if (
          !(await approved(
            dependencies.io,
            "Run the finite loopback-only pinned llama.cpp verification now? [y/q] ",
          ))
        ) {
          return { kind: "cancelled", state };
        }
        const storage = requiredStorage(state);
        const runtime = await protectedStep(
          () => dependencies.verifyRuntime(storage.path),
          "pinned llama.cpp verification",
          "No model was loaded and no runtime, model, placement, profile, or context was substituted.",
          "Restore the exact pinned runtime and resolve the reported loopback process failure.",
          "Rerun pinned llama.cpp verification.",
        );
        state = advanceFirstRun(state, {
          step: "llama-cpp",
          ...runtime,
        });
        break;
      }
      case "member-lan": {
        const interfaces = dependencies.currentInterfaces();
        if (interfaces.length === 0) {
          throw new Error(
            "Cause: no RFC 1918 private interface is available. Protected state: the Member gateway remains closed. Repair: connect the intended trusted LAN without a VPN substitution. Recheck: rerun Member LAN readiness.",
          );
        }
        interfaces.forEach((item, index) => {
          dependencies.io.print(`${index + 1}. ${item.name} — ${item.address}`);
        });
        const answer = (
          await dependencies.io.ask("Select one private interface (q to quit): ")
        ).trim();
        if (answer.toLowerCase() === "q") return { kind: "cancelled", state };
        const selected = interfaces[Number(answer) - 1];
        if (!selected) throw new Error("Select one listed private interface.");
        const binding = await protectedStep(
          async () =>
            await createMemberBinding({
              selected,
              available: dependencies.currentInterfaces(),
              bonjourName: await dependencies.resolveBonjourName(),
              port: options.memberPort ?? 39283,
            }),
          "Member Link preparation",
          "The Member listener remains closed; Host control remains loopback-only and no alternate interface was selected.",
          "Restore the selected private interface and actual Bonjour local hostname.",
          "Rerun Member LAN readiness.",
        );
        dependencies.io.print(`Friendly Member Link: ${binding.friendlyUrl}`);
        dependencies.io.print(`Private IPv4 fallback: ${binding.ipv4Url}`);
        dependencies.io.print(binding.qrAscii);
        if (
          !(await approved(
            dependencies.io,
            "Open the temporary selected-interface readiness listener? [y/q] ",
          ))
        ) {
          return { kind: "cancelled", state };
        }
        const physical = await protectedStep(
          () => dependencies.verifyPhysicalMember(binding),
          "physical Member readiness",
          "The temporary Member listener and Bonjour publication are closed; Host control remains loopback-only.",
          "Resolve the selected-interface, mDNS, firewall, guest-isolation, or physical-device cause.",
          "Rerun Member LAN readiness and open both exact links.",
        );
        if (!physical.physicalFriendlyPassed || !physical.physicalIpv4Passed) {
          throw new Error(
            "Cause: a physical Member did not open both exact links. Protected state: the readiness listener is closed and no alternate interface was used. Repair: check firewall permission, mDNS, guest isolation, and same-LAN access. Recheck: rerun Member LAN readiness.",
          );
        }
        state = advanceFirstRun(state, {
          step: "member-lan",
          interface: binding.interface,
          bonjourName: binding.bonjourName,
          port: binding.port,
          physicalFriendlyPassed: true,
          physicalIpv4Passed: true,
        });
        break;
      }
      case "web-search": {
        dependencies.io.print(
          "Web Search is unavailable in this candidate and remains disabled. No Docker install, image pull, account, trial, hosted endpoint, paid API, or fallback will run.",
        );
        if (!(await approved(dependencies.io, "Continue with Web Search disabled? [y/q] "))) {
          return { kind: "cancelled", state };
        }
        state = advanceFirstRun(state, { step: "web-search", choice: "disabled" });
        break;
      }
      case "start-localhub": {
        const answer = (
          await dependencies.io.ask('Type "Start LocalHub" to start this Run (q to quit): ')
        ).trim();
        if (answer.toLowerCase() === "q") return { kind: "cancelled", state };
        if (answer !== "Start LocalHub") {
          throw new Error("Start LocalHub requires the exact explicit confirmation.");
        }
        const storage = requiredStorage(state);
        const member = requiredMember(state);
        const binding = await createMemberBinding({
          selected: member.interface,
          available: dependencies.currentInterfaces(),
          bonjourName: member.bonjourName,
          port: member.port,
        });
        const run = await protectedStep(
          () => dependencies.startRun(storage.path, binding),
          "Start LocalHub",
          "No success is claimed and no alternate interface, runtime, model, or service is started.",
          "Resolve the exact reported Run or listener failure.",
          "Type Start LocalHub again, then run `lh run status`.",
        );
        hostOrigin = run.hostOrigin;
        state = advanceFirstRun(state, {
          step: "start-localhub",
          runId: run.runId,
          running: true,
          memberLinkOpen: true,
        });
        break;
      }
      case "ready": {
        if (!hostOrigin) {
          if (!state.runId) throw new Error("Ready is missing the exact LocalHub Run identity.");
          const inspected = await dependencies.inspectRun(state.runId);
          if (inspected.runId !== state.runId || !inspected.memberReady) {
            throw new Error(
              "The exact active Run and selected Member Link did not pass Ready recheck.",
            );
          }
          hostOrigin = inspected.hostOrigin;
        }
        await protectedStep(
          () => dependencies.openDashboard(hostOrigin as string),
          "Host dashboard open",
          "The exact Run remains active; no Member, model, or state was changed by the failed browser open.",
          "Open the displayed loopback Host origin manually.",
          "Run `lh run status` and reopen the Host dashboard.",
        );
        state = advanceFirstRun(state, {
          step: "ready",
          dashboardOpened: true,
          sharedModelAvailable: false,
        });
        dependencies.io.print(
          "Ready. The Host dashboard is open; a passing Shared Model is still required before Members can run inference.",
        );
        await writeFirstRunState(options.statePath, state);
        return { kind: "ready", state, hostOrigin };
      }
    }
    await writeFirstRunState(options.statePath, state);
  }
}

async function approved(io: GuidedRunwayIO, prompt: string): Promise<boolean> {
  const answer = (await io.ask(prompt)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function requiredStorage(
  state: FirstRunState,
): NonNullable<FirstRunState["choices"]["modelStorage"]> {
  if (!state.choices.modelStorage) throw new Error("Confirmed Model Storage is missing.");
  return state.choices.modelStorage;
}

function requiredMember(state: FirstRunState): NonNullable<FirstRunState["choices"]["member"]> {
  if (!state.choices.member) throw new Error("Confirmed Member interface is missing.");
  return state.choices.member;
}

function formatFailure(failure: ReturnType<typeof evaluateHostComputer>["failure"]): string {
  if (!failure) return "Host Computer check failed without a complete result.";
  return `Cause: ${failure.cause}. Protected state: ${failure.protectedState} Still works: ${failure.stillWorks} Repair: ${failure.repair} Recheck: ${failure.recheck}`;
}

async function protectedStep<T>(
  action: () => Promise<T>,
  label: string,
  protectedState: string,
  repair: string,
  recheck: string,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "failure" in error &&
      typeof error.failure === "object" &&
      error.failure !== null
    ) {
      const failure = error.failure as ReturnType<typeof evaluateHostComputer>["failure"];
      throw new Error(formatFailure(failure));
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cause: ${label} failed: ${cause}. Protected state: ${protectedState} Still works: Guided First Run can resume from confirmed non-secret choices. Repair: ${repair} Recheck: ${recheck}`,
    );
  }
}
