import { formatBytes, formatNumber } from "./format.ts";
import type { RuntimeSnapshot } from "./runtime.ts";
import type { CheckResult, LocalHubConfig, ModelInfo, RouteAttempt, RouteKind } from "./types.ts";

export function diagnose(snapshot: RuntimeSnapshot, config: LocalHubConfig): CheckResult[] {
  const checks: CheckResult[] = [];
  const expectedArch = snapshot.system.platform === "darwin" ? "arm64" : "x64";
  const supportedPlatform =
    snapshot.system.platform === "darwin" || snapshot.system.platform === "win32";
  const llms = snapshot.models.filter((model) => model.type === "llm");

  checks.push({
    name: "Platform",
    level: supportedPlatform ? "pass" : "fail",
    detail: `${snapshot.system.platform} ${snapshot.system.arch}`,
    ...(supportedPlatform ? {} : { fix: "Use the macOS arm64 or Windows x64 LocalHub build." }),
  });
  if (supportedPlatform && snapshot.system.arch !== expectedArch) {
    checks.push({
      name: "Architecture",
      level: "fail",
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
    const failedLanFallback =
      snapshot.route.kind === "windows-lmlink"
        ? lastFailedLanAttempt(snapshot.attempts)
        : undefined;
    if (failedLanFallback) {
      checks.push({
        name: "Direct LAN fallback",
        level: llms.length === 0 ? "fail" : "warn",
        detail: failedLanFallback.message ?? "Direct LAN fallback failed.",
        ...(failedLanFallback.fix ? { fix: failedLanFallback.fix } : {}),
      });
    }
  } else {
    checks.push(routeFailureCheck(snapshot.attempts));
  }

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
            fix: "Install a tool-capable LLM in LM Studio; LocalHub never downloads models.",
          },
  );

  const selected = selectedModel(snapshot.models, config.selectedModel);
  checks.push(
    !snapshot.route
      ? {
          name: "Context",
          level: "warn",
          detail: "Not checked because model discovery is unavailable.",
        }
      : selected?.maxContextLength !== undefined &&
          selected.maxContextLength >= config.contextLength
        ? {
            name: "Context",
            level: "pass",
            detail: `${selected.displayName} supports ${formatNumber(config.contextLength)} tokens.`,
          }
        : selected
          ? {
              name: "Context",
              level: "fail",
              detail: `${selected.displayName} supports ${formatNumber(selected.maxContextLength)} tokens, not ${formatNumber(config.contextLength)}.`,
              fix: "Choose a model with a larger maximum context or lower contextLength in LocalHub config.",
            }
          : {
              name: "Context",
              level: "warn",
              detail: "Not checked because no LLM is installed.",
            },
  );

  if (selected) {
    checks.push(toolCompatibilityCheck(selected));
    if (selected.maxContextLength >= config.contextLength) {
      const loaded = selected.loadedInstances.find(
        (instance) => instance.contextLength >= config.contextLength,
      );
      checks.push({
        name: "Selected load",
        level: loaded ? "pass" : "warn",
        detail: loaded
          ? loaded.contextLength === config.contextLength
            ? `${selected.displayName} is loaded at ${formatNumber(config.contextLength)} tokens.`
            : `${selected.displayName} provides ${formatNumber(loaded.contextLength)} tokens; LocalHub requested at least ${formatNumber(config.contextLength)}.`
          : `${selected.displayName} is not loaded with at least ${formatNumber(config.contextLength)} tokens.`,
        ...(loaded ? {} : { fix: "Press l in the TUI; launch also loads/reloads automatically." }),
      });
    }
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

function lastFailedLanAttempt(attempts: RouteAttempt[]): RouteAttempt | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt?.kind === "windows-lan" && !attempt.ok) {
      return attempt;
    }
  }
  return undefined;
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
