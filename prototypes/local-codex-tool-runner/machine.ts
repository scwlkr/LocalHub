export type Platform = "macOS" | "native Windows" | "WSL2";
export type Step = "invoke" | "connect" | "choose" | "boundary" | "queue" | "session" | "exit";
export type Failure =
  | "incompatible-package"
  | "friendly-name-unavailable"
  | "no-proven-model"
  | "sandbox-unavailable"
  | "connection-lost"
  | undefined;

export type JourneyState = {
  platform: Platform;
  step: Step;
  packageStatus: "not checked" | "complete pinned package";
  connection: "not connected" | "friendly name" | "direct IP" | "reconnecting";
  workspace: string;
  sharedModel: "not selected" | "Home Coder · Balanced · profile r7";
  sandbox: "not checked" | "workspace-write + local approvals";
  childCodex: "not started" | "disposable and credential-free" | "removed";
  ordinaryCodex: "untouched";
  queue: "not submitted" | "position 2" | "position 1" | "running" | "cancelled" | "finished";
  approval: "none" | "pending local approval" | "approved locally" | "denied locally";
  workspaceChanged: boolean;
  failure: Failure;
  note: string;
};

export type JourneyAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "cycle-platform" }
  | { type: "fail" }
  | { type: "retry" }
  | { type: "use-ip" }
  | { type: "request-approval" }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "exit" }
  | { type: "reset" };

const steps: Step[] = ["invoke", "connect", "choose", "boundary", "queue", "session", "exit"];
const platforms: Platform[] = ["macOS", "native Windows", "WSL2"];

function workspaceFor(platform: Platform): string {
  if (platform === "native Windows") return "C:\\Users\\Member\\Projects\\kitchen-board";
  if (platform === "WSL2") return "/home/member/projects/kitchen-board";
  return "/Users/member/Projects/kitchen-board";
}

export function initialJourney(platform: Platform = "macOS"): JourneyState {
  return {
    platform,
    step: "invoke",
    packageStatus: "not checked",
    connection: "not connected",
    workspace: workspaceFor(platform),
    sharedModel: "not selected",
    sandbox: "not checked",
    childCodex: "not started",
    ordinaryCodex: "untouched",
    queue: "not submitted",
    approval: "none",
    workspaceChanged: false,
    failure: undefined,
    note: "Ready to inspect the complete pinned Tool Runner package.",
  };
}

function previousStep(step: Step): Step {
  const index = steps.indexOf(step);
  return steps[Math.max(0, index - 1)] ?? "invoke";
}

function fail(state: JourneyState): JourneyState {
  const failures: Partial<Record<Step, Exclude<Failure, undefined>>> = {
    invoke: "incompatible-package",
    connect: "friendly-name-unavailable",
    choose: "no-proven-model",
    boundary: "sandbox-unavailable",
    queue: "connection-lost",
    session: "connection-lost",
  };
  const failure = failures[state.step];
  if (!failure) return state;
  return {
    ...state,
    failure,
    note: "Blocked safely. No fallback or duplicate request was started.",
  };
}

function next(state: JourneyState): JourneyState {
  if (state.failure) return { ...state, note: "Resolve the visible failure before continuing." };
  switch (state.step) {
    case "invoke":
      return {
        ...state,
        step: "connect",
        packageStatus: "complete pinned package",
        note: "Pinned LocalHub Tool Runner and Codex 0.145.0 package accepted.",
      };
    case "connect":
      return {
        ...state,
        step: "choose",
        connection: "friendly name",
        note: "Connected to Shane’s LocalHub at localhub.local (192.168.1.44).",
      };
    case "choose":
      return {
        ...state,
        step: "boundary",
        sharedModel: "Home Coder · Balanced · profile r7",
        note: "Selected one exact Shared Model with a passing Tool Runner Profile Test.",
      };
    case "boundary":
      return {
        ...state,
        step: "queue",
        sandbox: "workspace-write + local approvals",
        childCodex: "disposable and credential-free",
        queue: "position 2",
        note: "Boundary accepted. The first inference request entered the Request Queue.",
      };
    case "queue":
      if (state.queue === "position 2") {
        return {
          ...state,
          queue: "position 1",
          note: "Queue advanced; exact profile remains fixed.",
        };
      }
      return {
        ...state,
        step: "session",
        queue: "running",
        note: "Local Codex started; Host supplies inference only.",
      };
    case "session":
      return { ...state, note: "Use [a] to inspect a local approval or [e] to exit." };
    case "exit":
      return state;
  }
}

export function transition(state: JourneyState, action: JourneyAction): JourneyState {
  switch (action.type) {
    case "next":
      return next(state);
    case "back":
      return {
        ...state,
        step: previousStep(state.step),
        failure: undefined,
        note: "Moved back for review.",
      };
    case "cycle-platform": {
      const index = platforms.indexOf(state.platform);
      return initialJourney(platforms[(index + 1) % platforms.length] ?? "macOS");
    }
    case "fail":
      return fail(state);
    case "retry":
      return {
        ...state,
        failure: undefined,
        note:
          state.failure === "connection-lost"
            ? "Reconnected with the request cursor; no duplicate request was submitted."
            : "Repair confirmed. Retry can continue without weakening the boundary.",
      };
    case "use-ip":
      if (state.step !== "connect" || state.failure !== "friendly-name-unavailable") return state;
      return {
        ...state,
        step: "choose",
        connection: "direct IP",
        failure: undefined,
        note: "Connected through the displayed private-IP fallback: 192.168.1.44.",
      };
    case "request-approval":
      if (state.step !== "session") return state;
      return {
        ...state,
        approval: "pending local approval",
        note: "Codex paused locally before writing notes.md.",
      };
    case "approve":
      if (state.approval !== "pending local approval") return state;
      return {
        ...state,
        approval: "approved locally",
        workspaceChanged: true,
        note: "Approved locally. Only the selected Member workspace changed.",
      };
    case "deny":
      if (state.approval !== "pending local approval") return state;
      return { ...state, approval: "denied locally", note: "Denied locally. No file changed." };
    case "exit":
      return {
        ...state,
        step: "exit",
        childCodex: state.childCodex === "not started" ? "not started" : "removed",
        queue:
          state.queue === "running"
            ? "finished"
            : state.queue === "not submitted"
              ? "not submitted"
              : "cancelled",
        failure: undefined,
        note: "Disposable child state removed. Ordinary Codex remains untouched; approved workspace changes remain.",
      };
    case "reset":
      return initialJourney(state.platform);
  }
}
