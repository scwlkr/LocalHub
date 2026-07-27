import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createMemberBinding,
  createMemberGatewayHandler,
  isEligibleLanInterface,
  type MemberBinding,
  type PrivateInterface,
  reconcileMemberBinding,
  renderHostDashboard,
  renderStylesheet,
} from "./member-gateway.ts";
import { type InstalledModel, inspectInstalledModels } from "./model-acquisition.ts";
import {
  type FileIdentity,
  LLAMA_CPP_ARCHIVE_SHA256,
  LLAMA_CPP_BUILD,
  LLAMA_CPP_COMMIT,
  type ReleaseAssetInspection,
  type VerifiedReleaseCandidate,
  verifyReleaseCandidate,
} from "./release.ts";

export const RUN_STATE_SCHEMA = "localhub.run-state/v1";
export const DEFAULT_HOST_PORT = 39281;
export const DEFAULT_LLAMA_PORT = 39282;

export interface RunBundle {
  candidateId: string;
  commit: string;
  executable: FileIdentity;
  llama: {
    archiveDigest: string;
    binary: FileIdentity;
    binaryPath: string;
    build: "b10107";
    commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9";
  };
}

export interface RunFailure {
  cause: string;
  protectedState: string;
  stillWorks: string;
  repair: string;
  recheck: string;
}

export interface LocalHubRunState {
  schema: typeof RUN_STATE_SCHEMA;
  runId: string;
  candidateId: string;
  commit: string;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  acceptingWork: boolean;
  restartAttempts: number;
  supervisor: { pid: number; startedAt: string };
  host: { origin: string; health: "starting" | "ready" | "closed" | "failed" };
  llama: {
    pid: number | null;
    origin: string;
    build: "b10107";
    commit: "c0bc8591e8815c63cb01dd3f051a8b0df02501c9";
    architecture: "arm64";
    archiveDigest: string;
    binary: FileIdentity;
    devices: string[];
    launch: string[];
    listener: string;
    health: "starting" | "ready" | "closed" | "failed";
    model: null;
    runProfile: null;
    automaticFit: false;
    modelAutoload: false;
    builtInTools: false;
    builtInAgent: false;
    webUi: false;
    mcpProxy: false;
  };
  member?: {
    interface: PrivateInterface;
    bonjourName: string;
    port: number;
    friendlyUrl: string;
    ipv4Url: string;
    listener: string;
    health: "ready" | "closed" | "recheck-required";
    bonjourPublished: boolean;
    failure: RunFailure | null;
  } | null;
  activeWork: number;
  failure: RunFailure | null;
  stop: { activeWork: number; forcedProcesses: string[] } | null;
  updatedAt: string;
}

export interface LlamaLaunch {
  command: string[];
  observedControls: {
    host: "127.0.0.1";
    port: number;
    modelsDirectory: string;
    modelAutoload: false;
    automaticFit: false;
    webUi: false;
    builtInAgent: false;
    builtInTools: false;
    mcpProxy: false;
    model: null;
    runProfile: null;
  };
}

export interface SupervisorLaunch {
  command: string[];
  detached: true;
  stdio: ["ignore", string, string];
  cwd: string;
}

export interface RunMemberConfig {
  interface: PrivateInterface;
  bonjourName: string;
  port: number;
}

export interface BonjourPublication {
  exited: Promise<Error | null>;
  stop(): Promise<void>;
}

export interface BonjourProcessDependencies {
  spawn?: typeof spawn;
  sleep?: (milliseconds: number) => Promise<void>;
  waitForExit?: (child: ChildProcess, deadlineMs: number) => Promise<boolean>;
}

export interface ServeRunOptions {
  bundle: RunBundle;
  hostPort: number;
  llamaPort: number;
  stateDirectory: string;
  startupDeadlineMs: number;
  stopDeadlineMs: number;
  modelStorageDirectory?: string;
  member?: MemberBinding;
  currentInterfaces?: () => PrivateInterface[];
  memberCheckIntervalMs?: number;
  memberWakeGapMs?: number;
  now?: () => number;
  memberPeerAddress?: (request: Request) => string | null;
  beforeMemberVisit?: (route: "friendly" | "ipv4") => Promise<void>;
  publishBonjour?: (binding: MemberBinding) => Promise<BonjourPublication>;
  inspectModels?: (modelStorageDirectory: string) => Promise<InstalledModel[]>;
}

interface InspectDependencies {
  fetch?: Fetcher;
  readState?: (stateDirectory: string) => Promise<LocalHubRunState | null>;
}

export interface RunInspection {
  state: "running" | "stopped" | "failed";
  run: LocalHubRunState | null;
  failure: RunFailure | null;
  identityProven: boolean;
}

export interface RunCommandOptions {
  buildCommit: string;
  candidateRecordPath: string;
  executablePath: string;
  stateDirectory: string;
  hostPort?: number;
  llamaPort?: number;
  startupDeadlineMs?: number;
  stopDeadlineMs?: number;
  inspectReleaseAsset?: (path: string) => Promise<ReleaseAssetInspection>;
  modelStorageDirectory?: string;
  member?: RunMemberConfig;
}

export class RunCommandError extends Error {
  constructor(readonly failure: RunFailure) {
    super(failure.cause);
    this.name = "RunCommandError";
  }
}

export function buildLlamaLaunch(
  bundle: RunBundle,
  options: { modelsDirectory: string; port: number },
): LlamaLaunch {
  assertPort(options.port, "llama.cpp");
  const command = [
    bundle.llama.binaryPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--models-dir",
    options.modelsDirectory,
    "--no-models-autoload",
    "--models-max",
    "1",
    "--fit",
    "off",
    "--no-webui",
    "--no-agent",
    "--no-ui-mcp-proxy",
    "--cors-origins",
    "localhost",
  ];
  return {
    command,
    observedControls: {
      host: "127.0.0.1",
      port: options.port,
      modelsDirectory: options.modelsDirectory,
      modelAutoload: false,
      automaticFit: false,
      webUi: false,
      builtInAgent: false,
      builtInTools: false,
      mcpProxy: false,
      model: null,
      runProfile: null,
    },
  };
}

export function buildSupervisorLaunch(options: {
  candidateRecordPath: string;
  executablePath: string;
  hostPort: number;
  llamaPort: number;
  logPath: string;
  stateDirectory: string;
  modelStorageDirectory?: string;
  member?: RunMemberConfig;
}): SupervisorLaunch {
  assertPort(options.hostPort, "Host control");
  assertPort(options.llamaPort, "llama.cpp");
  if (options.hostPort === options.llamaPort) {
    throw new Error("Host control and llama.cpp must use distinct loopback ports.");
  }
  const command = [
    options.executablePath,
    "__run-agent",
    "--candidate",
    options.candidateRecordPath,
    "--state-dir",
    options.stateDirectory,
    "--host-port",
    String(options.hostPort),
    "--llama-port",
    String(options.llamaPort),
  ];
  if (options.modelStorageDirectory) {
    command.push("--model-storage", options.modelStorageDirectory);
  }
  if (options.member) {
    command.push(
      "--member-interface",
      options.member.interface.name,
      "--member-address",
      options.member.interface.address,
      "--member-netmask",
      options.member.interface.netmask,
      "--bonjour-name",
      options.member.bonjourName,
      "--member-port",
      String(options.member.port),
    );
  }
  return {
    command,
    detached: true,
    stdio: ["ignore", options.logPath, options.logPath],
    cwd: options.stateDirectory,
  };
}

export async function inspectLocalHubRun(
  stateDirectory: string,
  dependencies: InspectDependencies = {},
): Promise<RunInspection> {
  let state: LocalHubRunState | null;
  try {
    state = await (dependencies.readState ?? readRunState)(stateDirectory);
  } catch (error) {
    return failedInspection(
      null,
      `Run state is unreadable: ${errorMessage(error)}`,
      "No process was signalled and no model, configuration, or source file was changed.",
      "Move only the unreadable run-state.json aside after inspecting it.",
      "Run `lh run status` again.",
    );
  }
  if (!state || state.status === "stopped") {
    return { state: "stopped", run: state, failure: null, identityProven: false };
  }
  if (state.status === "failed" && state.host.health !== "ready") {
    return { state: "failed", run: state, failure: state.failure, identityProven: false };
  }
  const request = dependencies.fetch ?? fetch;
  let response: Response;
  let observed: LocalHubRunState;
  try {
    response = await finiteFetch(request, `${state.host.origin}/health`, {}, 1_000);
    if (!response.ok) {
      throw new Error(`Host health returned HTTP ${response.status}`);
    }
    observed = (await response.json()) as LocalHubRunState;
  } catch (error) {
    return failedInspection(
      state,
      `The recorded Host supervisor is not healthy: ${errorMessage(error)}`,
      "No process was signalled. Models, LM Studio, configuration, and source files remain untouched.",
      `Make sure only the LocalHub-owned process may use ${listenerFromOrigin(state.host.origin)}, then run \`lh run start\` explicitly.`,
      "Run `lh run status` again.",
    );
  }
  if (
    observed.schema !== RUN_STATE_SCHEMA ||
    observed.runId !== state.runId ||
    observed.candidateId !== state.candidateId ||
    observed.supervisor?.pid !== state.supervisor.pid
  ) {
    return failedInspection(
      state,
      `The process on ${listenerFromOrigin(state.host.origin)} does not match the recorded LocalHub Run identity.`,
      "No process was signalled and the mismatched listener was preserved for inspection.",
      `Stop the non-matching process that owns ${listenerFromOrigin(state.host.origin)} without changing LocalHub models or state.`,
      "Run `lh run status` again.",
    );
  }
  if (state.status === "failed") {
    return { state: "failed", run: observed, failure: state.failure, identityProven: true };
  }
  try {
    const llamaHealth = await finiteFetch(request, `${state.llama.origin}/health`, {}, 1_000);
    if (!llamaHealth.ok) {
      throw new Error(`llama.cpp health returned HTTP ${llamaHealth.status}`);
    }
  } catch (error) {
    return failedInspection(
      state,
      `The recorded llama.cpp worker is not healthy: ${errorMessage(error)}`,
      "New work is not accepted. No model, profile, or alternate runtime was selected.",
      "Run `lh stop`, then explicitly run `lh run start` with the same verified candidate.",
      "Run `lh run status` again.",
    );
  }
  return { state: "running", run: observed, failure: null, identityProven: true };
}

export function defaultRunStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOCALHUB_RUN_STATE_DIR) return resolve(env.LOCALHUB_RUN_STATE_DIR);
  if (env.XDG_STATE_HOME) return join(resolve(env.XDG_STATE_HOME), "localhub", "run-v1");
  return join(homedir(), "Library", "Application Support", "LocalHub", "run-v1");
}

export function runBundleFromCandidate(
  candidateRecordPath: string,
  candidate: VerifiedReleaseCandidate,
): RunBundle {
  const runtime = candidate.manifest.runtime?.llamaCpp;
  const dependency = candidate.manifest.dependencies.find((item) => item.name === "llama.cpp");
  if (!runtime || dependency?.included !== true) {
    throw new Error(
      "This assembled candidate does not include the pinned llama.cpp runtime. Protected state: no Run started and no substitute was searched. Repair: assemble the exact b10107 macOS-arm64 runtime into this candidate. Recheck: run `lh run start` again.",
    );
  }
  const binary = runtime.files.find(
    (entry): entry is Extract<(typeof runtime.files)[number], { kind: "file" }> =>
      entry.kind === "file" && entry.path === "llama-server",
  );
  if (!binary) {
    throw new Error("The verified runtime inventory does not contain llama-server.");
  }
  const candidateDirectory = dirname(resolve(candidateRecordPath));
  const candidateRelativeBinary = {
    ...binary,
    path: join(runtime.root, binary.path),
  };
  return {
    candidateId: candidate.candidate.candidateId,
    commit: candidate.manifest.release.commit,
    executable: candidate.candidate.asset,
    llama: {
      archiveDigest: `sha256:${runtime.archive.sha256}`,
      binary: candidateRelativeBinary,
      binaryPath: join(candidateDirectory, candidateRelativeBinary.path),
      build: LLAMA_CPP_BUILD,
      commit: LLAMA_CPP_COMMIT,
    },
  };
}

export async function startLocalHubRun(options: RunCommandOptions): Promise<LocalHubRunState> {
  const hostPort = options.hostPort ?? DEFAULT_HOST_PORT;
  const llamaPort = options.llamaPort ?? DEFAULT_LLAMA_PORT;
  assertPort(hostPort, "Host control");
  assertPort(llamaPort, "llama.cpp");
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.stateDirectory, 0o700);

  const prior = await readRunState(options.stateDirectory);
  if (
    prior &&
    (prior.status === "running" || prior.status === "starting" || prior.status === "stopping")
  ) {
    const inspection = await inspectLocalHubRun(options.stateDirectory);
    if (inspection.state === "running") {
      if (
        options.member &&
        inspection.identityProven &&
        inspection.run &&
        inspection.run.commit === options.buildCommit &&
        sameMemberConfig(inspection.run.member, options.member)
      ) {
        if (inspection.run.member?.health === "ready") return inspection.run;
        if (inspection.run.member?.health === "recheck-required") {
          await recheckMemberLink(options.stateDirectory);
          return await resumeExistingMemberRun(options, inspection.run.runId);
        }
      }
      throw new RunCommandError(
        runFailure(
          `LocalHub Run ${prior.runId} is already active.`,
          "The active Run and both loopback listeners were left unchanged.",
          "Use `lh run status` to inspect the exact active candidate and runtime.",
          "Use `lh stop` before starting another Run.",
          "Run `lh run status` again.",
        ),
      );
    }
    if (await anyRecordedProcessAlive(prior)) {
      throw new RunCommandError(
        inspection.failure ??
          runFailure(
            "A recorded LocalHub process is still alive but its identity cannot be proven.",
            "No process was signalled and no replacement Run was started.",
            "Models, LM Studio, configuration, and source files remain untouched.",
            "Inspect the recorded PIDs and loopback listeners, then stop only the proven owner.",
            "Run `lh run status` again.",
          ),
      );
    }
  }
  if (prior?.status === "failed" && (await anyRecordedProcessAlive(prior))) {
    throw new RunCommandError(
      runFailure(
        "A failed Run still has a recorded live process, so explicit recovery cannot safely replace it.",
        "No process was signalled and no replacement or alternate runtime was started.",
        "Models, LM Studio, configuration, and source files remain untouched.",
        "Inspect the recorded process and stop only the proven LocalHub owner.",
        "Run `lh run status` again.",
      ),
    );
  }

  let verified: VerifiedReleaseCandidate;
  try {
    verified = await verifyReleaseCandidate(options.candidateRecordPath, options.executablePath, {
      buildCommit: options.buildCommit,
      ...(options.inspectReleaseAsset ? { inspectAsset: options.inspectReleaseAsset } : {}),
    });
  } catch (error) {
    throw new RunCommandError(
      runFailure(
        `Candidate verification failed: ${errorMessage(error)}`,
        "No Run started and no runtime, model, configuration, or source file changed.",
        "The stopped LocalHub CLI remains available.",
        "Restore the exact assembled candidate and its exhaustive manifest.",
        "Run `lh release identity`, then `lh run start`.",
      ),
    );
  }
  let bundle: RunBundle;
  try {
    bundle = runBundleFromCandidate(options.candidateRecordPath, verified);
  } catch (error) {
    throw new RunCommandError(
      runFailure(
        errorMessage(error),
        "No Run started and no substitute runtime or model was selected.",
        "The stopped LocalHub CLI remains available.",
        "Assemble the exact pinned b10107 macOS-arm64 runtime into this candidate.",
        "Run `lh release identity`, then `lh run start`.",
      ),
    );
  }
  if (bundle.llama.archiveDigest !== `sha256:${LLAMA_CPP_ARCHIVE_SHA256}`) {
    throw new Error("Verified candidate returned a non-pinned llama.cpp archive digest.");
  }

  const logPath = join(options.stateDirectory, "supervisor.log");
  const launch = buildSupervisorLaunch({
    candidateRecordPath: options.candidateRecordPath,
    executablePath: options.executablePath,
    hostPort,
    llamaPort,
    logPath,
    stateDirectory: options.stateDirectory,
    ...(options.modelStorageDirectory
      ? { modelStorageDirectory: options.modelStorageDirectory }
      : {}),
    ...(options.member ? { member: options.member } : {}),
  });
  const logDescriptor = openSync(logPath, "a", 0o600);
  let supervisor: ChildProcess;
  try {
    supervisor = spawn(launch.command[0] ?? "", launch.command.slice(1), {
      cwd: launch.cwd,
      detached: launch.detached,
      env: supervisorEnvironment(process.env),
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    supervisor.unref();
  } catch (error) {
    throw new RunCommandError(
      runFailure(
        `LocalHub supervisor could not start: ${errorMessage(error)}`,
        "No alternate process or runtime was tried; models and configuration remain untouched.",
        "The stopped LocalHub CLI remains available.",
        "Restore execute permission on the exact candidate, then retry one explicit start.",
        "Run `lh run start`, then `lh run status`.",
      ),
    );
  } finally {
    closeSync(logDescriptor);
  }

  const deadline = Date.now() + (options.startupDeadlineMs ?? 30_000) + 5_000;
  while (Date.now() < deadline) {
    const state = await readRunState(options.stateDirectory);
    if (state?.status === "failed") {
      throw new RunCommandError(
        state.failure ??
          runFailure(
            "The LocalHub supervisor failed without a complete failure record.",
            "No new work is accepted.",
            "Models and configuration remain untouched.",
            "Inspect supervisor.log and restore the exact candidate.",
            "Run `lh run start`, then `lh run status`.",
          ),
      );
    }
    if (state?.status === "running") {
      const inspection = await inspectLocalHubRun(options.stateDirectory);
      if (
        inspection.state === "running" &&
        inspection.run &&
        (!options.member || inspection.run.member?.health === "ready")
      ) {
        return inspection.run;
      }
      if (inspection.state === "running" && inspection.run && options.member) {
        await Bun.sleep(25);
        continue;
      }
      throw new RunCommandError(inspection.failure as RunFailure);
    }
    await Bun.sleep(25);
  }
  const timedOut = await readRunState(options.stateDirectory);
  if (
    options.member &&
    timedOut?.status === "running" &&
    timedOut.member?.health === "recheck-required" &&
    sameMemberConfig(timedOut.member, options.member)
  ) {
    throw new RunCommandError(
      runFailure(
        `LocalHub Run ${timedOut.runId} remains active but physical Member verification did not complete before the finite deadline.`,
        "No duplicate Run was started; Host and llama.cpp remain on their exact listeners while Member inference remains unavailable.",
        "The loopback Host dashboard and physical-verification Member links remain available.",
        "Open both exact links from one physical device on the selected trusted LAN.",
        "Type `Start LocalHub` again to resume the exact Run readiness wait without starting another Run.",
      ),
    );
  }
  throw new RunCommandError(
    runFailure(
      "The LocalHub supervisor did not report Host, llama.cpp, and required physical Member readiness before the finite deadline.",
      "No success was claimed and no alternate port, runtime, model, or profile was tried.",
      "Models, LM Studio, configuration, and source files remain untouched.",
      "Inspect supervisor.log and the two exact loopback ports, then run `lh stop`.",
      "Run `lh run status` again.",
    ),
  );
}

async function resumeExistingMemberRun(
  options: RunCommandOptions,
  runId: string,
): Promise<LocalHubRunState> {
  const deadline = Date.now() + (options.startupDeadlineMs ?? 30_000);
  while (Date.now() < deadline) {
    const state = await readRunState(options.stateDirectory);
    if (!state || state.runId !== runId) {
      throw new RunCommandError(
        runFailure(
          "The exact active LocalHub Run changed while Member readiness was resuming.",
          "No duplicate Run was started and no process was signalled.",
          "The stopped or replacement Run state remains available for inspection.",
          "Inspect the exact Run identity before taking another lifecycle action.",
          "Run `lh run status` again.",
        ),
      );
    }
    if (state.status === "failed" || state.status === "stopped") {
      throw new RunCommandError(
        state.failure ??
          runFailure(
            "The exact Run stopped before Member readiness passed.",
            "No duplicate Run was started.",
            "Recorded Run state remains available.",
            "Resolve the recorded stop or failure before an explicit restart.",
            "Run `lh run status` again.",
          ),
      );
    }
    if (state.status === "running" && state.member?.health === "ready") {
      const inspection = await inspectLocalHubRun(options.stateDirectory);
      if (inspection.state === "running" && inspection.identityProven && inspection.run) {
        return inspection.run;
      }
      throw new RunCommandError(inspection.failure as RunFailure);
    }
    await Bun.sleep(25);
  }
  throw new RunCommandError(
    runFailure(
      `LocalHub Run ${runId} remains active but physical Member verification is still pending.`,
      "No duplicate Run was started and Member inference remains unavailable.",
      "The loopback Host dashboard and verification links remain available.",
      "Open both exact links from one physical device on the selected trusted LAN.",
      "Type `Start LocalHub` again to resume the exact Run readiness wait.",
    ),
  );
}

export async function stopLocalHubRun(options: {
  stateDirectory: string;
  stopDeadlineMs?: number;
  processAlive?: (pid: number) => boolean;
}): Promise<LocalHubRunState | null> {
  const state = await readRunState(options.stateDirectory);
  if (!state || state.status === "stopped") return state;
  const inspection = await inspectLocalHubRun(options.stateDirectory);
  const failedHostIsProven =
    state.status === "failed" &&
    state.host.health === "ready" &&
    inspection.identityProven &&
    inspection.run?.runId === state.runId &&
    inspection.run.supervisor.pid === state.supervisor.pid;
  if (inspection.state === "failed" && !failedHostIsProven) {
    if (await anyRecordedProcessAlive(state, options.processAlive)) {
      throw new RunCommandError(
        inspection.failure ??
          runFailure(
            "Recorded processes remain live but the LocalHub Run identity cannot be proven.",
            "No process was signalled.",
            "Models and configuration remain untouched.",
            "Inspect the recorded processes and stop only a proven LocalHub owner.",
            "Run `lh run status` again.",
          ),
      );
    }
    const stopped: LocalHubRunState = {
      ...state,
      status: "stopped",
      acceptingWork: false,
      host: { ...state.host, health: "closed" },
      llama: { ...state.llama, health: "closed" },
      member: state.member ? { ...state.member, health: "closed", bonjourPublished: false } : null,
      stop: { activeWork: state.activeWork, forcedProcesses: [] },
      updatedAt: new Date().toISOString(),
    };
    await writeRunState(options.stateDirectory, stopped);
    return stopped;
  }
  if (!inspection.run) return null;

  const response = await finiteFetch(
    fetch,
    `${inspection.run.host.origin}/stop`,
    { method: "POST", headers: { "x-localhub-run-id": inspection.run.runId } },
    2_000,
  );
  if (!response.ok) {
    throw new RunCommandError(
      runFailure(
        `Stop LocalHub was rejected with HTTP ${response.status}.`,
        "No unverified process was signalled and the Run remains observable.",
        "Models, LM Studio, configuration, and source files remain untouched.",
        "Verify the recorded Run identity and retry the explicit stop.",
        "Run `lh run status` again.",
      ),
    );
  }
  const handling = (await response.json()) as { activeWork?: number };
  const deadline = Date.now() + (options.stopDeadlineMs ?? 10_000) + 1_000;
  while (Date.now() < deadline) {
    const current = await readRunState(options.stateDirectory);
    if (
      current?.status === "stopped" &&
      !(await anyRecordedProcessAlive(current, options.processAlive))
    ) {
      if (
        (await listenerResponds(current.host.origin)) ||
        (await listenerResponds(current.llama.origin)) ||
        (current.member !== undefined &&
          current.member !== null &&
          (await listenerResponds(current.member.ipv4Url)))
      ) {
        await Bun.sleep(25);
        continue;
      }
      return {
        ...current,
        stop: current.stop ?? { activeWork: handling.activeWork ?? 0, forcedProcesses: [] },
      };
    }
    await Bun.sleep(25);
  }
  throw new RunCommandError(
    runFailure(
      "Stop LocalHub exceeded its finite process/listener deadline after rejecting new work.",
      "No process was signalled after the deadline; no model, LM Studio process, configuration, or source file was touched; no substitute service started.",
      "The recorded state and logs remain available for inspection.",
      "Inspect the recorded LocalHub-owned PIDs and loopback listeners, then retry `lh stop`.",
      "Run `lh run status` again.",
    ),
  );
}

export async function recheckMemberLink(
  stateDirectory: string,
): Promise<NonNullable<LocalHubRunState["member"]>> {
  const inspection = await inspectLocalHubRun(stateDirectory);
  if (
    inspection.state !== "running" ||
    !inspection.identityProven ||
    !inspection.run ||
    !inspection.run.member
  ) {
    throw new RunCommandError(
      runFailure(
        "The exact active LocalHub Run and Member boundary could not be proven.",
        "No listener was opened, closed, or rebound.",
        "The loopback Host status remains available.",
        "Restore the exact Run identity before requesting a Member recheck.",
        "Run `lh run status`, then `lh member recheck`.",
      ),
    );
  }
  const response = await finiteFetch(
    fetch,
    `${inspection.run.host.origin}/member/recheck`,
    {
      method: "POST",
      headers: { "x-localhub-run-id": inspection.run.runId },
    },
    5_000,
  );
  if (!response.ok) {
    throw new RunCommandError(
      runFailure(
        `Member recheck failed with HTTP ${response.status}.`,
        "The old Member Link remains closed and no alternate interface was selected.",
        "The exact Run and loopback Host dashboard remain available.",
        "Confirm the intended private interface and resolve the reported network cause.",
        "Run `lh member recheck` again.",
      ),
    );
  }
  const body = (await response.json()) as { member?: LocalHubRunState["member"] };
  if (body.member?.health !== "ready" && body.member?.health !== "recheck-required") {
    throw new Error("Member recheck returned no exact verification boundary.");
  }
  return body.member;
}

export async function serveLocalHubRun(options: ServeRunOptions): Promise<void> {
  assertPort(options.hostPort, "Host control");
  assertPort(options.llamaPort, "llama.cpp");
  if (options.hostPort === options.llamaPort) {
    throw new Error("Host control and llama.cpp must use distinct loopback ports.");
  }
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(options.stateDirectory, 0o700);
  const routerModelsDirectory = await mkdtemp(join(options.stateDirectory, "sealed-router-"));
  await chmod(routerModelsDirectory, 0o700);
  const logPath = join(options.stateDirectory, "llama-server.log");
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const launch = buildLlamaLaunch(options.bundle, {
    modelsDirectory: routerModelsDirectory,
    port: options.llamaPort,
  });
  const publicLaunch = [
    `$CANDIDATE/${options.bundle.llama.binary.path}`,
    ...launch.command
      .slice(1)
      .map((argument) =>
        argument === routerModelsDirectory ? "$LOCALHUB_STATE/sealed-router" : argument,
      ),
  ];
  let state: LocalHubRunState = {
    schema: RUN_STATE_SCHEMA,
    runId,
    candidateId: options.bundle.candidateId,
    commit: options.bundle.commit,
    status: "starting",
    acceptingWork: false,
    restartAttempts: 0,
    supervisor: { pid: process.pid, startedAt },
    host: { origin: `http://127.0.0.1:${options.hostPort}`, health: "starting" },
    llama: {
      pid: null,
      origin: `http://127.0.0.1:${options.llamaPort}`,
      build: options.bundle.llama.build,
      commit: options.bundle.llama.commit,
      architecture: "arm64",
      archiveDigest: options.bundle.llama.archiveDigest,
      binary: options.bundle.llama.binary,
      devices: [],
      launch: publicLaunch,
      listener: `127.0.0.1:${options.llamaPort}`,
      health: "starting",
      model: null,
      runProfile: null,
      automaticFit: false,
      modelAutoload: false,
      builtInTools: false,
      builtInAgent: false,
      webUi: false,
      mcpProxy: false,
    },
    member: options.member ? memberState(options.member, "closed", false, null) : null,
    activeWork: 0,
    failure: null,
    stop: null,
    updatedAt: startedAt,
  };
  await writeRunState(options.stateDirectory, state);

  let llama: ChildProcess | null = null;
  let host: ReturnType<typeof Bun.serve> | null = null;
  let member: ReturnType<typeof Bun.serve> | null = null;
  let memberBinding = options.member ?? null;
  let bonjour: BonjourPublication | null = null;
  let memberMonitor: ReturnType<typeof setInterval> | null = null;
  let memberWithdrawn = false;
  const memberCheckIntervalMs = options.memberCheckIntervalMs ?? 1_000;
  const memberClock = options.now ?? Date.now;
  const memberWakeGapMs = options.memberWakeGapMs ?? Math.max(memberCheckIntervalMs * 3, 3_000);
  let lastMemberCheckAt = memberClock();
  let stopping = false;
  let lifecycleResolve!: () => void;
  const lifecycle = new Promise<void>((resolve) => {
    lifecycleResolve = resolve;
  });

  let stateWrite = Promise.resolve();
  const setState = async (next: LocalHubRunState): Promise<void> => {
    state = { ...next, updatedAt: new Date().toISOString() };
    const snapshot = state;
    const commit = stateWrite.then(async () => {
      await writeRunState(options.stateDirectory, snapshot);
    });
    stateWrite = commit.catch(() => undefined);
    await commit;
  };

  let crashTask: Promise<void> | null = null;
  let crashRecordError: Error | null = null;
  let shutdownOutcome: Promise<void> | null = null;
  const recordCrash = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
    const failure = runFailure(
      `Pinned llama.cpp exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`,
      "New work is rejected. No model, profile, runtime, or source was substituted.",
      "The loopback Host health surface and stopped LocalHub CLI remain available.",
      "Inspect the local llama-server.log, run `lh stop`, then explicitly start the same verified candidate again.",
      "Run `lh run status` again.",
    );
    await setState({
      ...state,
      status: "failed",
      acceptingWork: false,
      host: { ...state.host, health: "ready" },
      llama: { ...state.llama, health: "failed" },
      failure,
    });
  };

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (crashTask) await crashTask;
    const forcedProcesses: string[] = [];
    await setState({ ...state, status: "stopping", acceptingWork: false, activeWork: 0 });
    if (memberMonitor) {
      clearInterval(memberMonitor);
      memberMonitor = null;
    }
    if (member) {
      await member.stop(true);
      member = null;
    }
    if (bonjour) {
      await bonjour.stop();
      bonjour = null;
    }
    if (llama && llama.exitCode === null && llama.signalCode === null) {
      llama.kill("SIGTERM");
      if (!(await waitForExit(llama, options.stopDeadlineMs))) {
        llama.kill("SIGKILL");
        forcedProcesses.push("llama-server");
        if (!(await waitForExit(llama, options.stopDeadlineMs))) {
          throw new Error("the recorded llama.cpp process remained live after SIGKILL");
        }
      }
    }
    if (host) {
      await host.stop(true);
      host = null;
    }
    await setState({
      ...state,
      status: "stopped",
      acceptingWork: false,
      host: { ...state.host, health: "closed" },
      llama: { ...state.llama, health: "closed" },
      member: state.member ? { ...state.member, health: "closed", bonjourPublished: false } : null,
      stop: { activeWork: 0, forcedProcesses },
    });
    lifecycleResolve();
  };

  const requestShutdown = (): void => {
    if (shutdownOutcome) return;
    shutdownOutcome = shutdown().catch((error) => {
      crashRecordError = error instanceof Error ? error : new Error(String(error));
      lifecycleResolve();
    });
  };

  const signalStop = (): void => {
    requestShutdown();
  };
  process.once("SIGTERM", signalStop);
  process.once("SIGINT", signalStop);

  try {
    const startupDeadline = Date.now() + options.startupDeadlineMs;
    const versionOutput = await runFinite(
      [options.bundle.llama.binaryPath, "--version"],
      remainingDeadline(startupDeadline),
    );
    const deviceOutput = await runFinite(
      [options.bundle.llama.binaryPath, "--list-devices"],
      remainingDeadline(startupDeadline),
    );
    if (!/version:\s*10107\b/.test(versionOutput) || !versionOutput.includes("c0bc8591e")) {
      throw new Error("the included binary did not report pinned build b10107 at c0bc8591e");
    }
    const devices = deviceOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (devices.length === 0) {
      throw new Error("the included binary returned no device inventory");
    }

    const logDescriptor = openSync(logPath, "a", 0o600);
    try {
      llama = spawn(launch.command[0] ?? "", launch.command.slice(1), {
        cwd: options.stateDirectory,
        env: exactLlamaEnvironment(process.env, options.stateDirectory),
        stdio: ["ignore", logDescriptor, logDescriptor],
      });
    } finally {
      closeSync(logDescriptor);
    }
    state = {
      ...state,
      llama: { ...state.llama, pid: llama.pid ?? null, devices },
    };
    await setState(state);
    let unexpectedExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let reachedRunning = false;
    llama.once("exit", (code, signal) => {
      if (!stopping) {
        unexpectedExit = { code, signal };
        if (reachedRunning && !crashTask) {
          crashTask = recordCrash(code, signal).catch((error) => {
            crashRecordError = error instanceof Error ? error : new Error(String(error));
          });
        }
      }
    });

    const healthDeadline = startupDeadline;
    let lastHealth = "no response";
    while (Date.now() < healthDeadline) {
      if (unexpectedExit) {
        throw new Error("the pinned llama.cpp process exited before health passed");
      }
      try {
        const response = await finiteFetch(fetch, `${state.llama.origin}/health`, {}, 250);
        if (response.ok) {
          lastHealth = "ready";
          break;
        }
        lastHealth = `HTTP ${response.status}`;
      } catch (error) {
        lastHealth = errorMessage(error);
      }
      await Bun.sleep(20);
    }
    if (lastHealth !== "ready") {
      throw new Error(
        `pinned llama.cpp did not become healthy before the finite deadline (${lastHealth})`,
      );
    }
    if (process.platform === "darwin") {
      await verifyListenerOwner(options.llamaPort, llama.pid);
    }

    const withdrawMember = async (failure: RunFailure): Promise<void> => {
      if (memberWithdrawn) return;
      memberWithdrawn = true;
      const closure = Promise.all([
        member ? member.stop(true) : Promise.resolve(),
        bonjour ? bonjour.stop() : Promise.resolve(),
      ]);
      member = null;
      bonjour = null;
      memberBinding = null;
      if (state.member) {
        await setState({
          ...state,
          member: {
            ...state.member,
            health: "recheck-required",
            bonjourPublished: false,
            failure,
          },
        });
      }
      await closure;
    };

    const startMemberService = async (
      binding: MemberBinding,
      requirePhysicalVerification: boolean,
    ): Promise<void> => {
      const reconciliation = reconcileMemberBinding(
        binding,
        (options.currentInterfaces ?? currentPrivateInterfaces)(),
      );
      if (reconciliation.status === "withdrawn") throw new Error(reconciliation.failure.cause);
      const visited = { friendly: false, ipv4: false };
      let verificationCommitted = false;
      let verificationOpen = false;
      let server: ReturnType<typeof Bun.serve> | null = null;
      let currentPublication: BonjourPublication | null = null;
      const completePhysicalVerification = (): void => {
        if (
          !requirePhysicalVerification ||
          !verificationOpen ||
          verificationCommitted ||
          memberWithdrawn ||
          stopping ||
          member !== server ||
          currentPublication === null ||
          bonjour !== currentPublication ||
          !visited.friendly ||
          !visited.ipv4
        ) {
          return;
        }
        verificationCommitted = true;
        void setState({
          ...state,
          member: memberState(binding, "ready", true, null),
        }).catch((error) => {
          crashRecordError = error instanceof Error ? error : new Error(String(error));
          lifecycleResolve();
        });
      };
      const handler = createMemberGatewayHandler(
        binding,
        (request) =>
          options.memberPeerAddress
            ? options.memberPeerAddress(request)
            : (server?.requestIP(request)?.address ?? null),
        async (route, peer) => {
          await options.beforeMemberVisit?.(route);
          const normalized = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
          if (normalized !== binding.interface.address) {
            visited[route] = true;
            completePhysicalVerification();
          }
        },
        () => (state.member?.health === "ready" ? "ready" : "verification-required"),
      );
      server = Bun.serve({
        hostname: binding.interface.address,
        port: binding.port,
        fetch: handler,
      });
      let publication: BonjourPublication;
      try {
        publication = await (options.publishBonjour ?? publishBonjourService)(binding);
      } catch (error) {
        await server.stop(true);
        throw error;
      }
      member = server;
      memberBinding = binding;
      bonjour = publication;
      currentPublication = publication;
      memberWithdrawn = false;
      void publication.exited.then((failure) => {
        if (!failure || stopping || bonjour !== publication) return;
        void withdrawMember(
          runFailure(
            `Bonjour publication failed after Member start: ${failure.message}`,
            "The Member listener and stale publication are closed; no alternate name, address, or interface was selected.",
            "The loopback Host dashboard and exact Run remain available.",
            "Restore the local mDNS publication boundary without renaming or substituting the Host.",
            "Run `lh member recheck` and open both displayed links again.",
          ),
        ).catch((error) => {
          crashRecordError = error instanceof Error ? error : new Error(String(error));
          lifecycleResolve();
        });
      });
      await setState({
        ...state,
        member: memberState(
          binding,
          requirePhysicalVerification ? "recheck-required" : "ready",
          true,
          requirePhysicalVerification
            ? runFailure(
                "A physical Member must reopen both the exact friendly and IPv4 links after start, wake, or rebind.",
                "The new selected-interface listener exposes only the inert readiness page; Member inference remains unavailable.",
                "The loopback Host dashboard and exact Run remain available.",
                "Open both displayed links from one physical device on the selected trusted LAN.",
                "Run `lh member recheck` again after both links open.",
              )
            : null,
        ),
      });
      lastMemberCheckAt = memberClock();
      verificationOpen = true;
      completePhysicalVerification();
    };

    host = Bun.serve({
      hostname: "127.0.0.1",
      port: options.hostPort,
      async fetch(request) {
        const url = new URL(request.url);
        const expectedHost = new URL(state.host.origin).host;
        const peer = host?.requestIP(request)?.address ?? null;
        if (request.headers.get("host")?.toLowerCase() !== expectedHost.toLowerCase()) {
          return Response.json({ error: "Host control name did not match." }, { status: 421 });
        }
        if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") {
          return Response.json({ error: "Host control is loopback-only." }, { status: 403 });
        }
        if (request.method === "GET" && url.pathname === "/") {
          return new Response(
            renderHostDashboard(state.member?.health !== "closed" ? memberBinding : null, state),
            {
              headers: {
                "cache-control": "no-store",
                "content-security-policy":
                  "default-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
                "content-type": "text/html; charset=utf-8",
                "x-content-type-options": "nosniff",
                "x-frame-options": "DENY",
              },
            },
          );
        }
        if (request.method === "GET" && url.pathname === "/localhub.css") {
          return new Response(renderStylesheet(), {
            headers: {
              "cache-control": "no-store",
              "content-type": "text/css; charset=utf-8",
              "x-content-type-options": "nosniff",
            },
          });
        }
        if (request.method === "GET" && url.pathname === "/health") {
          return Response.json(state);
        }
        if (request.method === "GET" && url.pathname === "/models") {
          try {
            return Response.json({
              installedModels: options.modelStorageDirectory
                ? await (options.inspectModels ?? inspectInstalledModels)(
                    options.modelStorageDirectory,
                  )
                : [],
            });
          } catch (error) {
            return Response.json(
              {
                error: `Installed Model inventory unavailable: ${errorMessage(error)}. No substitute inventory was used.`,
              },
              { status: 503 },
            );
          }
        }
        if (request.method === "POST" && url.pathname === "/member/recheck") {
          if (request.headers.get("x-localhub-run-id") !== state.runId) {
            return Response.json(
              { error: "LocalHub Run identity did not match." },
              { status: 409 },
            );
          }
          if (!options.member || !state.member) {
            return Response.json({ error: "Member recheck is not required." }, { status: 409 });
          }
          if (state.member.health === "ready") {
            return Response.json({ status: "ready", member: state.member });
          }
          if (member && bonjour) {
            return Response.json(
              { status: "physical-verification-required", member: state.member },
              { status: 202 },
            );
          }
          const replacement = (options.currentInterfaces ?? currentPrivateInterfaces)().find(
            (item) => item.name === options.member?.interface.name && isEligibleLanInterface(item),
          );
          if (!replacement) {
            return Response.json(
              { error: "Selected private interface remains unavailable." },
              { status: 503 },
            );
          }
          try {
            const rebound = await createMemberBinding({
              selected: replacement,
              available: (options.currentInterfaces ?? currentPrivateInterfaces)(),
              bonjourName: options.member.bonjourName,
              port: options.member.port,
            });
            await startMemberService(rebound, true);
            return Response.json(
              { status: "physical-verification-required", member: state.member },
              { status: 202 },
            );
          } catch (error) {
            return Response.json({ error: errorMessage(error) }, { status: 503 });
          }
        }
        if (request.method === "POST" && url.pathname === "/stop") {
          const apiAuthorized = request.headers.get("x-localhub-run-id") === state.runId;
          const formAuthorized =
            url.searchParams.get("run-id") === state.runId &&
            request.headers.get("origin") === state.host.origin;
          if (!apiAuthorized && !formAuthorized) {
            return Response.json(
              { error: "LocalHub Run identity did not match." },
              { status: 409 },
            );
          }
          const response = Response.json({ acceptingWork: false, activeWork: 0 });
          queueMicrotask(requestShutdown);
          return response;
        }
        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });
    if (process.platform === "darwin") {
      await verifyListenerOwner(options.hostPort, process.pid);
    }
    if (memberBinding) {
      await startMemberService(memberBinding, true);
      memberMonitor = setInterval(() => {
        if (!memberBinding || memberWithdrawn || stopping) return;
        const checkedAt = memberClock();
        const timerGap = checkedAt - lastMemberCheckAt;
        lastMemberCheckAt = checkedAt;
        if (timerGap > memberWakeGapMs) {
          void withdrawMember(
            runFailure(
              `Host wake or timer suspension created a ${timerGap} ms Member boundary gap.`,
              "The Member listener and Bonjour publication are closed before any same-address reuse.",
              "The loopback Host dashboard and exact Run remain available.",
              "Confirm the selected LAN after wake without substituting a VPN or another interface.",
              "Run `lh member recheck` and open both displayed links again.",
            ),
          ).catch((error) => {
            crashRecordError = error instanceof Error ? error : new Error(String(error));
            lifecycleResolve();
          });
          return;
        }
        const reconciliation = reconcileMemberBinding(
          memberBinding,
          (options.currentInterfaces ?? currentPrivateInterfaces)(),
        );
        if (reconciliation.status === "withdrawn") {
          void withdrawMember(reconciliation.failure).catch((error) => {
            crashRecordError = error instanceof Error ? error : new Error(String(error));
            lifecycleResolve();
          });
        }
      }, memberCheckIntervalMs);
      memberMonitor.unref();
    }
    await setState({
      ...state,
      status: "running",
      acceptingWork: true,
      host: { ...state.host, health: "ready" },
      llama: { ...state.llama, health: "ready" },
    });
    reachedRunning = true;
    const exitedAfterReady = unexpectedExit as {
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null;
    if (exitedAfterReady && !crashTask) {
      crashTask = recordCrash(exitedAfterReady.code, exitedAfterReady.signal).catch((error) => {
        crashRecordError = error instanceof Error ? error : new Error(String(error));
      });
    }
    await lifecycle;
    if (shutdownOutcome) await shutdownOutcome;
    if (crashRecordError) throw crashRecordError;
  } catch (error) {
    if (stopping) {
      if (llama && llama.exitCode === null && llama.signalCode === null) {
        llama.kill("SIGKILL");
        await waitForExit(llama, options.stopDeadlineMs);
      }
      if (host) {
        await host.stop(true);
        host = null;
      }
      if (memberMonitor) clearInterval(memberMonitor);
      await stopOptionalServer(member);
      await stopOptionalBonjour(bonjour);
      const failure = runFailure(
        `LocalHub Run stop failed: ${errorMessage(error)}`,
        "New work is rejected and no substitute process, runtime, model, or profile was started.",
        "Models, LM Studio, configuration, source files, and the recorded local logs remain untouched.",
        "Inspect the recorded LocalHub-owned PID and listeners; stop only that exact owner before retrying.",
        "Run `lh run status` again.",
      );
      await setState({
        ...state,
        status: "failed",
        acceptingWork: false,
        host: { ...state.host, health: "closed" },
        llama: { ...state.llama, health: "failed" },
        member: state.member
          ? { ...state.member, health: "closed", bonjourPublished: false }
          : null,
        failure,
      });
    } else {
      stopping = true;
      if (llama && llama.exitCode === null && llama.signalCode === null) {
        llama.kill("SIGTERM");
        if (!(await waitForExit(llama, options.stopDeadlineMs))) {
          llama.kill("SIGKILL");
          await waitForExit(llama, options.stopDeadlineMs);
        }
      }
      if (host) {
        await host.stop(true);
        host = null;
      }
      if (memberMonitor) clearInterval(memberMonitor);
      await stopOptionalServer(member);
      await stopOptionalBonjour(bonjour);
      const failure = runFailure(
        `LocalHub Run start failed: ${errorMessage(error)}`,
        "No model or Run Profile was loaded; no alternate runtime was tried; LM Studio, models, configuration, and source files remain untouched.",
        "Legacy LocalHub commands still work; this Run remains stopped.",
        "Resolve the exact reported runtime, loopback listener, selected-interface listener, or Bonjour publication cause without substituting another boundary.",
        "Run `lh run start`, then `lh run status`.",
      );
      await setState({
        ...state,
        status: "failed",
        acceptingWork: false,
        host: { ...state.host, health: "failed" },
        llama: { ...state.llama, health: "failed" },
        member: state.member
          ? { ...state.member, health: "closed", bonjourPublished: false }
          : null,
        failure,
      });
    }
    throw error;
  } finally {
    process.off("SIGTERM", signalStop);
    process.off("SIGINT", signalStop);
    await rm(routerModelsDirectory, { recursive: true, force: true });
  }
}

export async function readRunState(stateDirectory: string): Promise<LocalHubRunState | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(stateDirectory, "run-state.json"), "utf8"),
    );
    validateRunState(parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateRunState(value: unknown): asserts value is LocalHubRunState {
  if (!isRecord(value) || value.schema !== RUN_STATE_SCHEMA) {
    throw new Error(
      `unsupported run-state schema ${String(isRecord(value) ? value.schema : value)}`,
    );
  }
  const supervisor = value.supervisor;
  const host = value.host;
  const llama = value.llama;
  if (
    !nonempty(value.runId) ||
    !nonempty(value.candidateId) ||
    !isHex(value.commit, 40) ||
    !["starting", "running", "stopping", "stopped", "failed"].includes(String(value.status)) ||
    typeof value.acceptingWork !== "boolean" ||
    value.restartAttempts !== 0 ||
    !isRecord(supervisor) ||
    !validPid(supervisor.pid) ||
    !nonempty(supervisor.startedAt) ||
    !isRecord(host) ||
    !loopbackOrigin(host.origin) ||
    !["starting", "ready", "closed", "failed"].includes(String(host.health)) ||
    !isRecord(llama) ||
    (llama.pid !== null && !validPid(llama.pid)) ||
    !loopbackOrigin(llama.origin) ||
    llama.build !== LLAMA_CPP_BUILD ||
    llama.commit !== LLAMA_CPP_COMMIT ||
    llama.architecture !== "arm64" ||
    !/^sha256:[0-9a-f]{64}$/.test(String(llama.archiveDigest)) ||
    !validFileIdentity(llama.binary) ||
    !stringArray(llama.devices) ||
    !stringArray(llama.launch) ||
    llama.listener !== new URL(String(llama.origin)).host ||
    !["starting", "ready", "closed", "failed"].includes(String(llama.health)) ||
    llama.model !== null ||
    llama.runProfile !== null ||
    llama.automaticFit !== false ||
    llama.modelAutoload !== false ||
    llama.builtInTools !== false ||
    llama.builtInAgent !== false ||
    llama.webUi !== false ||
    llama.mcpProxy !== false ||
    !validMemberState(value.member) ||
    !nonnegativeInteger(value.activeWork) ||
    !validFailure(value.failure) ||
    !validStop(value.stop) ||
    !nonempty(value.updatedAt)
  ) {
    throw new Error("run state is incomplete, unsafe, or malformed");
  }
}

function validMemberState(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !isRecord(value.interface)) return false;
  const selected = value.interface;
  if (
    !nonempty(selected.name) ||
    !nonempty(selected.address) ||
    !nonempty(selected.netmask) ||
    !nonempty(value.bonjourName) ||
    !nonnegativeInteger(value.port) ||
    Number(value.port) < 1024 ||
    Number(value.port) > 65535 ||
    !nonempty(value.friendlyUrl) ||
    !nonempty(value.ipv4Url) ||
    !nonempty(value.listener) ||
    !["ready", "closed", "recheck-required"].includes(String(value.health)) ||
    typeof value.bonjourPublished !== "boolean" ||
    !validFailure(value.failure)
  ) {
    return false;
  }
  const selectedInterface: PrivateInterface = {
    name: selected.name,
    address: selected.address,
    netmask: selected.netmask,
  };
  if (!isEligibleLanInterface(selectedInterface)) return false;
  if (
    (value.health === "ready" && (value.bonjourPublished !== true || value.failure !== null)) ||
    (value.health === "closed" && value.bonjourPublished !== false) ||
    (value.health === "recheck-required" && value.failure === null)
  ) {
    return false;
  }
  try {
    const friendly = new URL(value.friendlyUrl);
    const ipv4 = new URL(value.ipv4Url);
    return (
      friendly.protocol === "http:" &&
      friendly.hostname === value.bonjourName &&
      friendly.port === String(value.port) &&
      friendly.origin === value.friendlyUrl &&
      ipv4.protocol === "http:" &&
      ipv4.hostname === selected.address &&
      ipv4.port === String(value.port) &&
      ipv4.origin === value.ipv4Url &&
      ipv4.host === value.listener &&
      value.listener === `${selected.address}:${String(value.port)}`
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function validPid(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 1;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function loopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.origin === value;
  } catch {
    return false;
  }
}

function validFileIdentity(value: unknown): value is FileIdentity {
  return (
    isRecord(value) &&
    nonempty(value.path) &&
    nonnegativeInteger(value.size) &&
    isHex(value.sha256, 64)
  );
}

function validFailure(value: unknown): value is RunFailure | null {
  return (
    value === null ||
    (isRecord(value) &&
      nonempty(value.cause) &&
      nonempty(value.protectedState) &&
      nonempty(value.stillWorks) &&
      nonempty(value.repair) &&
      nonempty(value.recheck))
  );
}

function validStop(value: unknown): value is LocalHubRunState["stop"] {
  return (
    value === null ||
    (isRecord(value) && nonnegativeInteger(value.activeWork) && stringArray(value.forcedProcesses))
  );
}

export async function writeRunState(
  stateDirectory: string,
  state: LocalHubRunState,
): Promise<void> {
  const finalPath = join(stateDirectory, "run-state.json");
  const temporaryPath = join(stateDirectory, `run-state.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, finalPath);
}

function memberState(
  binding: MemberBinding,
  health: "ready" | "closed" | "recheck-required",
  bonjourPublished: boolean,
  failure: RunFailure | null,
): NonNullable<LocalHubRunState["member"]> {
  return {
    interface: { ...binding.interface },
    bonjourName: binding.bonjourName,
    port: binding.port,
    friendlyUrl: binding.friendlyUrl,
    ipv4Url: binding.ipv4Url,
    listener: new URL(binding.ipv4Url).host,
    health,
    bonjourPublished,
    failure,
  };
}

function sameMemberConfig(member: LocalHubRunState["member"], expected: RunMemberConfig): boolean {
  return Boolean(
    member &&
      member.interface.name === expected.interface.name &&
      member.interface.address === expected.interface.address &&
      member.interface.netmask === expected.interface.netmask &&
      member.bonjourName === expected.bonjourName &&
      member.port === expected.port,
  );
}

export function currentPrivateInterfaces(): PrivateInterface[] {
  const result: PrivateInterface[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const candidate = { name, address: entry.address, netmask: entry.netmask };
      if (entry.family === "IPv4" && !entry.internal && isEligibleLanInterface(candidate)) {
        result.push(candidate);
      }
    }
  }
  return result;
}

export async function publishBonjourService(
  binding: MemberBinding,
  dependencies: BonjourProcessDependencies = {},
): Promise<BonjourPublication> {
  if (process.platform !== "darwin") {
    throw new Error("Bonjour publication is available only on the supported macOS Host.");
  }
  const child = (dependencies.spawn ?? spawn)(
    "/usr/bin/dns-sd",
    ["-i", binding.interface.name, "-R", "LocalHub", "_http._tcp", "local.", String(binding.port)],
    { stdio: "ignore" },
  );
  let stopRequested = false;
  const exited = new Promise<Error | null>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve(
        stopRequested
          ? null
          : new Error(
              `dns-sd exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`,
            ),
      );
    });
    child.once("error", (error) => resolve(error));
  });
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  await (dependencies.sleep ?? Bun.sleep)(100);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error("Bonjour publication exited before the Member Link was ready.");
  }
  let stopped = false;
  return {
    exited,
    async stop() {
      if (stopped) return;
      stopped = true;
      stopRequested = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        if (!(await (dependencies.waitForExit ?? waitForExit)(child, 1_000))) {
          child.kill("SIGKILL");
          if (!(await (dependencies.waitForExit ?? waitForExit)(child, 1_000))) {
            throw new Error("Bonjour cleanup could not prove dns-sd exit after SIGKILL.");
          }
        }
      }
    },
  };
}

async function stopOptionalServer(server: ReturnType<typeof Bun.serve> | null): Promise<void> {
  if (server) await server.stop(true);
}

async function stopOptionalBonjour(publication: BonjourPublication | null): Promise<void> {
  if (publication) await publication.stop();
}

function exactLlamaEnvironment(
  source: NodeJS.ProcessEnv,
  stateDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEM_VERSION_COMPAT"]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  environment.LLAMA_CACHE = join(stateDirectory, "runtime-cache");
  return environment;
}

function supervisorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEM_VERSION_COMPAT"]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

async function anyRecordedProcessAlive(
  state: LocalHubRunState,
  processAlive: (pid: number) => boolean = isPidAlive,
): Promise<boolean> {
  return (
    processAlive(state.supervisor.pid) ||
    (state.llama.pid !== null && processAlive(state.llama.pid))
  );
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function listenerResponds(origin: string): Promise<boolean> {
  try {
    await finiteFetch(fetch, `${origin}/health`, {}, 150);
    return true;
  } catch {
    return false;
  }
}

async function runFinite(command: string[], deadlineMs: number): Promise<string> {
  const child = spawn(command[0] ?? "", command.slice(1), {
    env: exactLlamaEnvironment(process.env, process.cwd()),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exited = waitForExit(child, deadlineMs);
  if (!(await exited)) {
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
    throw new Error(`${command[1] ?? "runtime check"} exceeded its finite deadline`);
  }
  const output =
    `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`.trim();
  if (child.exitCode !== 0) {
    throw new Error(`${command[1] ?? "runtime check"} exited ${String(child.exitCode)}: ${output}`);
  }
  return output;
}

async function verifyListenerOwner(port: number, expectedPid: number | undefined): Promise<void> {
  if (!expectedPid) throw new Error(`listener ${port} has no recorded owner process`);
  const output = await runFinite(
    ["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    2_000,
  );
  const owners = [...new Set(output.split(/\s+/).filter(Boolean).map(Number))];
  if (owners.length !== 1 || owners[0] !== expectedPid) {
    throw new Error(`listener ${port} is not owned only by the recorded LocalHub process`);
  }
}

async function waitForExit(child: ChildProcess, deadlineMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, deadlineMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function finiteFetch(
  request: Fetcher,
  input: string,
  init: RequestInit,
  deadlineMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await request(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function failedInspection(
  state: LocalHubRunState | null,
  cause: string,
  protectedState: string,
  repair: string,
  recheck: string,
): RunInspection {
  return {
    state: "failed",
    run: state,
    identityProven: false,
    failure: runFailure(
      cause,
      protectedState,
      "Legacy LocalHub commands and untouched models remain available.",
      repair,
      recheck,
    ),
  };
}

function runFailure(
  cause: string,
  protectedState: string,
  stillWorks: string,
  repair: string,
  recheck: string,
): RunFailure {
  return { cause, protectedState, stillWorks, repair, recheck };
}

function listenerFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "the recorded loopback listener";
  }
}

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${label} port must be an exact unprivileged TCP port.`);
  }
}

function remainingDeadline(overallDeadline: number): number {
  return Math.max(1, overallDeadline - Date.now());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
