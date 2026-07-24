import { authLabel, diagnose, routeName } from "./diagnostics.ts";
import { formatBytes, formatNumber } from "./format.ts";
import type { RuntimeSnapshot } from "./runtime.ts";
import type { CheckResult, LocalHubConfig, ModelInfo } from "./types.ts";

export function renderStatus(
  snapshot: RuntimeSnapshot,
  config: LocalHubConfig,
  path: string,
): string {
  const lines = [
    "LocalHub",
    `System     ${snapshot.system.platform} ${snapshot.system.arch} · ${snapshot.system.hostname}`,
    `CPU        ${snapshot.system.cpu}`,
    `Memory     ${memoryLabel(snapshot)}`,
    `Directory  ${snapshot.system.cwd}`,
    `Codex      ${snapshot.codexPath ?? "missing"}`,
    `Config     ${path}`,
    `Context    ${formatNumber(config.contextLength)} tokens`,
  ];

  if (snapshot.route) {
    lines.push(
      `Route      ${routeName(snapshot.route.kind)}`,
      `Device     ${snapshot.route.device}`,
      `Server     online · ${snapshot.route.endpoint}`,
      `Auth       ${authLabel(snapshot.route.auth)}`,
    );
    for (const attempt of snapshot.attempts.filter((candidate) => !candidate.ok)) {
      lines.push(
        `Attempt    ${routeName(attempt.kind)} · ${attempt.message ?? "failed"}`,
        ...(attempt.fix ? [`Fix        ${attempt.fix}`] : []),
      );
    }
  } else {
    lines.push("Route      unavailable", "Server     offline");
    for (const attempt of snapshot.attempts) {
      lines.push(
        `Attempt    ${routeName(attempt.kind)} · ${attempt.message ?? "failed"}`,
        ...(attempt.fix ? [`Fix        ${attempt.fix}`] : []),
      );
    }
  }

  lines.push(
    "",
    snapshot.route
      ? `Models (${snapshot.models.length})`
      : "Models (unavailable while server is offline)",
  );
  if (snapshot.models.length === 0 && snapshot.route) {
    lines.push("  none");
  } else {
    for (const model of snapshot.models) {
      lines.push(...modelStatusLines(model));
    }
  }
  return lines.join("\n");
}

export function renderDoctor(checks: CheckResult[]): string {
  return [
    "LocalHub doctor",
    ...checks.flatMap((check) => {
      const icon = check.level === "pass" ? "PASS" : check.level === "warn" ? "WARN" : "FAIL";
      return [
        `${icon.padEnd(4)}  ${check.name}: ${check.detail}`,
        ...(check.fix ? [`      Fix: ${check.fix}`] : []),
      ];
    }),
  ].join("\n");
}

export function renderTuiSummary(snapshot: RuntimeSnapshot | null, config: LocalHubConfig): string {
  if (!snapshot) {
    return "Route: checking\nServer: checking\nCodex: checking";
  }
  const llms = snapshot.models.filter((model) => model.type === "llm");
  const embeddings = snapshot.models.length - llms.length;
  const loaded = snapshot.models.filter((model) => model.loadedInstances.length > 0).length;
  const route = snapshot.route;
  const lastAttempt = snapshot.attempts.at(-1);
  return [
    `Route: ${route ? routeName(route.kind) : "unavailable"} · Server: ${route ? "online" : "offline"} · Auth: ${route ? authLabel(route.auth) : "unknown"}`,
    `Device: ${route?.device ?? "unknown"} · Endpoint: ${route?.endpoint ?? lastAttempt?.endpoint ?? config.localEndpoint}`,
    `Codex: ${snapshot.codexPath ? "ready" : "missing"} · Context: ${formatNumber(config.contextLength)} · Memory: ${memoryLabel(snapshot)}`,
    `Directory: ${snapshot.system.cwd}`,
    `Inventory: ${llms.length} LLM · ${embeddings} embedding · ${loaded} loaded`,
  ].join("\n");
}

export function renderModelDetails(model: ModelInfo | null): string {
  if (!model) {
    return "No LLM selected.";
  }
  const loaded = model.loadedInstances.length
    ? model.loadedInstances
        .map((instance) => `${instance.id} @ ${formatNumber(instance.contextLength)}`)
        .join(", ")
    : "not loaded";
  const capability = model.capabilities;
  const tool =
    capability?.trainedForToolUse === true
      ? "yes"
      : capability?.trainedForToolUse === false
        ? "no (Codex tools may be unreliable)"
        : "unknown";
  const reasoning = capability?.reasoning
    ? capability.reasoning.allowedOptions.join("/")
    : "not advertised";
  return [
    `${model.displayName} · ${model.key}`,
    `${model.publisher} · ${model.architecture ?? "unknown arch"} · ${model.format ?? "unknown format"} · ${quantizationLabel(model)}`,
    `Size ${formatBytes(model.sizeBytes)} · Max context ${formatNumber(model.maxContextLength)} · Params ${model.paramsString ?? "unknown"}`,
    `Loaded: ${loaded}`,
    `Capabilities: tools ${tool} · vision ${yesNoUnknown(capability?.vision)} · reasoning ${reasoning}`,
  ].join("\n");
}

export function renderTuiDiagnostics(snapshot: RuntimeSnapshot, config: LocalHubConfig): string {
  return diagnose(snapshot, config)
    .map((check) => {
      const icon = check.level === "pass" ? "✓" : check.level === "warn" ? "!" : "×";
      return `${icon} ${check.name}: ${check.detail}${check.fix ? ` Fix: ${check.fix}` : ""}`;
    })
    .join("\n");
}

export function modelOption(model: ModelInfo): {
  name: string;
  description: string;
  value: string;
} {
  const loaded = model.loadedInstances.length > 0 ? "●" : "○";
  const tool = model.capabilities?.trainedForToolUse === true ? "tools" : "tools?";
  return {
    name: `${loaded} ${model.displayName}`,
    description: `${quantizationLabel(model)} · ${formatBytes(model.sizeBytes)} · max ${formatNumber(model.maxContextLength)} · ${tool}`,
    value: model.key,
  };
}

function modelStatusLines(model: ModelInfo): string[] {
  const loaded = model.loadedInstances.length
    ? model.loadedInstances
        .map((instance) => `${instance.id}@${formatNumber(instance.contextLength)}`)
        .join(", ")
    : "no";
  return [
    `  ${model.displayName} [${model.type}]`,
    `    key=${model.key}`,
    `    ${quantizationLabel(model)} · ${formatBytes(model.sizeBytes)} · max=${formatNumber(model.maxContextLength)} · loaded=${loaded}`,
    `    tools=${yesNoUnknown(model.capabilities?.trainedForToolUse)} · vision=${yesNoUnknown(model.capabilities?.vision)}`,
  ];
}

function quantizationLabel(model: ModelInfo): string {
  if (!model.quantization) {
    return "quantization unknown";
  }
  const bits =
    model.quantization.bitsPerWeight === null ? "" : `/${model.quantization.bitsPerWeight} bpw`;
  return `${model.quantization.name ?? "quantization unknown"}${bits}`;
}

function yesNoUnknown(value: boolean | null | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function memoryLabel(snapshot: RuntimeSnapshot): string {
  return snapshot.system.freeMemoryBytes === null
    ? `${formatBytes(snapshot.system.totalMemoryBytes)} total`
    : `${formatBytes(snapshot.system.freeMemoryBytes)} free / ${formatBytes(snapshot.system.totalMemoryBytes)} total`;
}
