import { formatBytes, formatNumber } from "./format.ts";
import type { RuntimeSnapshot } from "./runtime.ts";
import type { CheckResult, LocalHubConfig, ModelInfo, RouteAttempt, RouteKind } from "./types.ts";

export function diagnose(snapshot: RuntimeSnapshot, config: LocalHubConfig): CheckResult[] {
  const checks: CheckResult[] = [];
  const expectedArch = snapshot.system.platform === "darwin" ? "arm64" : "x64";
  const supportedPlatform =
    snapshot.system.platform === "darwin" || snapshot.system.platform === "win32";

  checks.push({
    name: "Platform",
    level: supportedPlatform ? "pass" : "fail",
    detail: `${snapshot.system.platform} ${snapshot.system.arch}`,
    ...(supportedPlatform ? {} : { fix: "Use the macOS arm64 or Windows x64 LocalHub build." }),
  });
  if (supportedPlatform && snapshot.system.arch !== expectedArch) {
    checks.push({
      name: "Architecture",
      level: "warn",
      detail: `Expected ${expectedArch}; found ${snapshot.system.arch}.`,
      fix: `Install the ${snapshot.system.platform === "darwin" ? "macOS arm64" : "Windows x64"} build.`,
    });
  }

  checks.push(
    snapshot.codexPath
      ? {
          name: "Codex",
          level: "pass",
          detail: snapshot.codexPath,
        }
      : {
          name: "Codex",
          level: "fail",
          detail: "`codex` is not available on PATH.",
          fix: "Install Codex, reopen the terminal, and confirm `codex --version` works.",
        },
  );

  if (snapshot.route) {
    checks.push({
      name: "LM Studio API",
      level: "pass",
      detail: `${routeName(snapshot.route.kind)} at ${snapshot.route.endpoint}`,
    });
    checks.push({
      name: "Authentication",
      level:
        snapshot.route.kind === "windows-lan" && snapshot.route.auth !== "accepted"
          ? "fail"
          : "pass",
      detail: authLabel(snapshot.route.auth),
    });
    if (snapshot.route.kind === "windows-lmlink") {
      checks.push({
        name: "LM Link device",
        level: "warn",
        detail: "REST cannot prove which linked device will run inference.",
        fix: "In Windows LM Studio, set the 64 GB Mac as the preferred LM Link device.",
      });
    }
    if (snapshot.route.kind === "windows-lan" && snapshot.route.endpoint.startsWith("http://")) {
      checks.push({
        name: "LAN transport",
        level: "warn",
        detail: "Authenticated HTTP is not encrypted.",
        fix: "Use only on a trusted LAN; prefer LM Link when available.",
      });
    }
  } else {
    checks.push(routeFailureCheck(snapshot.attempts));
  }

  const llms = snapshot.models.filter((model) => model.type === "llm");
  checks.push(
    !snapshot.route
      ? {
          name: "LLM inventory",
          level: "warn",
          detail: "Not checked because the LM Studio API is unavailable.",
          fix: "Start the server, then run `lh doctor` again.",
        }
      : llms.length > 0
        ? {
            name: "LLM inventory",
            level: "pass",
            detail: `${llms.length} installed model(s)`,
          }
        : {
            name: "LLM inventory",
            level: "fail",
            detail: "No installed LLMs were returned.",
            fix: "Install Kimi 3 or another tool-capable LLM in LM Studio; LocalHub never downloads models.",
          },
  );

  const contextReady = llms.filter((model) => model.maxContextLength >= config.contextLength);
  checks.push(
    !snapshot.route
      ? {
          name: "Context",
          level: "warn",
          detail: "Not checked because model discovery is unavailable.",
        }
      : contextReady.length > 0
        ? {
            name: "Context",
            level: "pass",
            detail: `${contextReady.length} model(s) support ${formatNumber(config.contextLength)} tokens`,
          }
        : {
            name: "Context",
            level: llms.length === 0 ? "warn" : "fail",
            detail: `No model supports the configured ${formatNumber(config.contextLength)} tokens.`,
            fix: "Choose a model with a larger maximum context or lower contextLength in LocalHub config.",
          },
  );

  const selected = selectedModel(snapshot.models, config.selectedModel);
  if (selected) {
    checks.push(toolCompatibilityCheck(selected));
    const exact = selected.loadedInstances.some(
      (instance) => instance.contextLength === config.contextLength,
    );
    checks.push({
      name: "Selected load",
      level: exact ? "pass" : "warn",
      detail: exact
        ? `${selected.displayName} is loaded at ${formatNumber(config.contextLength)} tokens.`
        : `${selected.displayName} is not loaded at ${formatNumber(config.contextLength)} tokens.`,
      ...(exact ? {} : { fix: "Press l in the TUI; launch also loads/reloads automatically." }),
    });
  }

  checks.push({
    name: "Memory",
    level: "pass",
    detail:
      snapshot.system.freeMemoryBytes === null
        ? `${formatBytes(snapshot.system.totalMemoryBytes)} total`
        : `${formatBytes(snapshot.system.freeMemoryBytes)} free / ${formatBytes(snapshot.system.totalMemoryBytes)} total`,
  });
  return checks;
}

export function toolCompatibilityCheck(model: ModelInfo): CheckResult {
  const capability = model.capabilities?.trainedForToolUse;
  if (capability === true) {
    return {
      name: "Tool compatibility",
      level: "pass",
      detail: `${model.displayName} reports native tool-use training.`,
    };
  }
  if (capability === false) {
    return {
      name: "Tool compatibility",
      level: "warn",
      detail: `${model.displayName} is not trained for tool use; Codex calls may be unreliable.`,
      fix: "Prefer a model whose LM Studio capabilities report trained_for_tool_use=true.",
    };
  }
  return {
    name: "Tool compatibility",
    level: "warn",
    detail: `${model.displayName} does not advertise tool-use compatibility.`,
    fix: "Test a real Codex tool call or choose a model with advertised tool-use training.",
  };
}

function selectedModel(models: ModelInfo[], preferred?: string): ModelInfo | null {
  const llms = models.filter((model) => model.type === "llm");
  return llms.find((model) => model.key === preferred) ?? llms[0] ?? null;
}

function routeFailureCheck(attempts: RouteAttempt[]): CheckResult {
  const last = attempts.at(-1);
  return {
    name: "LM Studio API",
    level: "fail",
    detail: last?.message ?? "No supported route is configured.",
    fix:
      last?.fix ??
      "Start LM Studio's Developer server. On Windows, configure LM Link or authenticated direct LAN.",
  };
}

export function routeName(kind: RouteKind): string {
  switch (kind) {
    case "mac-local":
      return "Mac local";
    case "windows-lmlink":
      return "Windows local / LM Link";
    case "windows-lan":
      return "Windows direct LAN";
    default:
      return kind;
  }
}

export function authLabel(auth: string): string {
  switch (auth) {
    case "not-required":
      return "not required";
    case "accepted":
      return "token accepted";
    case "missing":
      return "token missing";
    case "rejected":
      return "token rejected";
    default:
      return "unknown";
  }
}
