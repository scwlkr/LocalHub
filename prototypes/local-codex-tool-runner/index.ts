// PROTOTYPE ONLY — an in-memory terminal journey for “Prototype the local Codex Tool Runner journey.”
import { createInterface } from "node:readline/promises";
import { initialJourney, transition, type JourneyAction, type JourneyState } from "./machine.ts";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const cyan = "\x1b[36m";
const amber = "\x1b[33m";
const reset = "\x1b[0m";

const stepNames: Record<JourneyState["step"], string> = {
  invoke: "Install or invoke",
  connect: "Find the Host",
  choose: "Choose local work",
  boundary: "Review the boundary",
  queue: "Wait honestly",
  session: "Work locally",
  exit: "Exit cleanly",
};

function platformDetail(state: JourneyState): string {
  if (state.platform === "native Windows") {
    return "Complete Windows package; one-time elevated sandbox setup may be required.";
  }
  if (state.platform === "WSL2") {
    return "Complete Linux package inside WSL2; bundled bwrap; use a Linux workspace path.";
  }
  return "Complete Apple-arm64 package; local macOS sandbox; no ordinary Codex login needed.";
}

function failureDetail(state: JourneyState): string[] {
  switch (state.failure) {
    case "incompatible-package":
      return [
        "BLOCKED · This client does not match the Host’s pinned Codex/LocalHub seam.",
        "Install the exact displayed release, then retry. No compatibility fallback.",
      ];
    case "friendly-name-unavailable":
      return [
        "NOT FOUND · localhub.local did not resolve on this computer.",
        "Use the Host dashboard’s current private IP; never guess or scan the LAN.",
      ];
    case "no-proven-model":
      return [
        "UNAVAILABLE · No Shared Model has a current passing Tool Runner Profile Test.",
        "Ask the Host to test and share one exact profile. Chat-only fallback is not Codex-capable.",
      ];
    case "sandbox-unavailable":
      return [
        "BLOCKED · The required local sandbox is unavailable.",
        state.platform === "native Windows"
          ? "Run the displayed one-time elevated setup, then return. Codex itself will not run elevated."
          : "Repair the complete pinned package, then retry. Unsandboxed fallback is forbidden.",
      ];
    case "connection-lost":
      return [
        "CONNECTION LOST · The request is not silently duplicated or moved to another model.",
        "Retry resumes from its request cursor when possible; otherwise it ends with an explicit reason.",
      ];
    default:
      return [];
  }
}

function stageDetail(state: JourneyState): string[] {
  if (state.failure) return failureDetail(state);
  switch (state.step) {
    case "invoke":
      return [
        platformDetail(state),
        "New computer: install one verified release. Returning Member: run `lh codex`.",
        "The package includes pinned Codex 0.145.0; no account, token, or global configuration.",
      ];
    case "connect":
      return [
        "Try the Host-provided friendly address first: localhub.local.",
        "Show the Host name and current private IP before connecting; direct IP is the explicit fallback.",
      ];
    case "choose":
      return [
        `Workspace: ${state.workspace}`,
        "Offer only exact Shared Models whose current profile passed the real Tool Runner test.",
        "Fixture choice: Home Coder · Balanced · profile r7 · shell/input/plan proof passing.",
      ];
    case "boundary":
      return [
        "Tools execute on this computer; the Host supplies inference and sees inference content.",
        "Local Codex may change only the chosen workspace under its local sandbox and approvals.",
        "Normal login, config, history, plugins, MCP, skills, agents, search, and credentials stay out.",
      ];
    case "queue":
      return [
        `Request Queue: ${state.queue} · 5-second keepalive · exact profile locked`,
        "Closing the connection does not create a duplicate. Cancel ends the queued request explicitly.",
      ];
    case "session":
      return [
        "Codex runs here. shell_command, request_user_input, and update_plan are profile-proven.",
        `Local approval: ${state.approval} · Host-side llama.cpp tools: disabled`,
        "Approved workspace changes survive; the disposable child home does not.",
      ];
    case "exit":
      return [
        `Child-only CODEX_HOME: ${state.childCodex}`,
        `Ordinary Codex config/auth/history: ${state.ordinaryCodex}`,
        `Selected workspace changed: ${state.workspaceChanged ? "yes — approved changes remain" : "no"}`,
      ];
  }
}

function shortcuts(state: JourneyState): string {
  if (state.failure === "friendly-name-unavailable")
    return "[i] use shown IP  [r] retry name  [b] back  [e] exit  [q] quit";
  if (state.failure) return "[r] repair & retry  [b] back  [e] exit  [q] quit";
  if (state.step === "invoke")
    return "[n] use complete package  [p] platform  [f] mismatch  [e] exit  [q] quit";
  if (state.step === "session" && state.approval === "pending local approval") {
    return "[y] approve locally  [d] deny locally  [f] lose connection  [e] exit  [q] quit";
  }
  if (state.step === "session")
    return "[a] local approval  [f] lose connection  [e] exit  [b] back  [q] quit";
  if (state.step === "exit") return "[0] restart  [q] quit";
  return "[n] continue  [f] show failure  [b] back  [e] exit  [q] quit";
}

function render(state: JourneyState): string {
  const stepNumber = Object.keys(stepNames).indexOf(state.step) + 1;
  const lines = [
    `${bold}${cyan}LOCALHUB TOOL RUNNER${reset}  ${dim}THROWAWAY PROTOTYPE · no network or file actions${reset}`,
    `${bold}Stage ${stepNumber}/7 · ${stepNames[state.step]}${reset}`,
    "",
    `${bold}Platform${reset}       ${state.platform}`,
    `${bold}Host${reset}           ${state.connection === "not connected" ? "not connected" : `Shane’s LocalHub · ${state.connection}`}`,
    `${bold}Workspace${reset}      ${state.workspace}`,
    `${bold}Shared Model${reset}   ${state.sharedModel}`,
    `${bold}Sandbox${reset}        ${state.sandbox}`,
    `${bold}Child Codex${reset}    ${state.childCodex}`,
    `${bold}Ordinary Codex${reset} ${state.ordinaryCodex}`,
    "",
    ...(state.failure
      ? [`${bold}${amber}FAIL-CLOSED PATH${reset}`]
      : [`${bold}CURRENT DECISION${reset}`]),
    ...stageDetail(state).map((line) => `• ${line}`),
    "",
    `${dim}${state.note}${reset}`,
    "",
    shortcuts(state),
  ];
  return lines.join("\n");
}

function actionFor(input: string): JourneyAction | undefined {
  const actions: Record<string, JourneyAction> = {
    n: { type: "next" },
    b: { type: "back" },
    p: { type: "cycle-platform" },
    f: { type: "fail" },
    r: { type: "retry" },
    i: { type: "use-ip" },
    a: { type: "request-approval" },
    y: { type: "approve" },
    d: { type: "deny" },
    e: { type: "exit" },
    "0": { type: "reset" },
  };
  return actions[input];
}

const readline = createInterface({ input: process.stdin, output: process.stdout });
let state = initialJourney();

while (true) {
  console.clear();
  console.log(render(state));
  const input = (await readline.question("\n> ")).trim().toLowerCase();
  if (input === "q") break;
  const action = actionFor(input);
  if (action) state = transition(state, action);
}

readline.close();
console.log("Prototype closed. Nothing was installed, connected, or changed.");
