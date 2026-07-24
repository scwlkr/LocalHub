import { hostname } from "node:os";
import { type FetchLike, LmStudioClient, LmStudioError } from "./lmstudio.ts";
import type {
  ActiveRoute,
  AuthState,
  LocalHubConfig,
  ModelInfo,
  RouteAttempt,
  RouteKind,
  SupportedPlatform,
} from "./types.ts";

export interface ResolvedRoute {
  active: ActiveRoute | null;
  attempts: RouteAttempt[];
  client: LmStudioClient | null;
  models: ModelInfo[];
}

interface Candidate {
  kind: RouteKind;
  endpoint: string;
  tokenRequired: boolean;
}

export function routeCandidates(platform: NodeJS.Platform, config: LocalHubConfig): Candidate[] {
  if (platform === "darwin") {
    return [{ kind: "mac-local", endpoint: config.localEndpoint, tokenRequired: false }];
  }
  if (platform === "win32") {
    const candidates: Candidate[] = [
      { kind: "windows-lmlink", endpoint: config.localEndpoint, tokenRequired: false },
    ];
    if (config.lanEndpoint) {
      candidates.push({
        kind: "windows-lan",
        endpoint: config.lanEndpoint,
        tokenRequired: true,
      });
    }
    return candidates;
  }
  return [];
}

export async function resolveRoute(options: {
  platform?: NodeJS.Platform;
  config: LocalHubConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  hostname?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResolvedRoute> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const token = env[options.config.tokenEnv];
  const attempts: RouteAttempt[] = [];
  let deferredLocal: ResolvedRoute | null = null;

  for (const candidate of routeCandidates(platform, options.config)) {
    if (candidate.tokenRequired && !token) {
      attempts.push({
        kind: candidate.kind,
        endpoint: candidate.endpoint,
        auth: "missing",
        ok: false,
        errorKind: "authentication",
        message: "Direct-LAN access requires an API token.",
        fix: `Set ${options.config.tokenEnv} in this shell to an LM Studio API token.`,
      });
      continue;
    }

    if (candidate.tokenRequired && token) {
      const anonymousProbe = new LmStudioClient(candidate.endpoint, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
      try {
        await anonymousProbe.listModels(options.signal);
        attempts.push({
          kind: candidate.kind,
          endpoint: candidate.endpoint,
          auth: "not-required",
          ok: false,
          errorKind: "authentication",
          message: "Direct-LAN server accepted an unauthenticated request.",
          fix: "Enable Require Authentication in LM Studio before using direct LAN.",
        });
        continue;
      } catch (error) {
        if (isCancellationError(error)) {
          throw error;
        }
        if (!isAuthenticationError(error)) {
          attempts.push(failedAttempt(candidate, error, "unknown", options.config.tokenEnv));
          continue;
        }
      }

      const authenticated = new LmStudioClient(candidate.endpoint, {
        fetch: options.fetch,
        token,
        timeoutMs: options.timeoutMs,
      });
      try {
        const models = await authenticated.listModels(options.signal);
        const resolved = successfulResolution(
          candidate,
          "accepted",
          platform,
          options.hostname,
          authenticated,
          models,
          attempts,
        );
        if (shouldTryLanFallback(candidate, options.config, models)) {
          deferredLocal = resolved;
          continue;
        }
        return resolved;
      } catch (error) {
        if (isCancellationError(error)) {
          throw error;
        }
        const auth = isAuthenticationError(error) ? "rejected" : "unknown";
        attempts.push(failedAttempt(candidate, error, auth, options.config.tokenEnv));
        continue;
      }
    }

    const unauthenticated = new LmStudioClient(candidate.endpoint, {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    try {
      const models = await unauthenticated.listModels(options.signal);
      const resolved = successfulResolution(
        candidate,
        "not-required",
        platform,
        options.hostname,
        unauthenticated,
        models,
        attempts,
      );
      if (shouldTryLanFallback(candidate, options.config, models)) {
        deferredLocal = resolved;
        continue;
      }
      return resolved;
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      if (!isAuthenticationError(error)) {
        attempts.push(failedAttempt(candidate, error, "unknown", options.config.tokenEnv));
        continue;
      }
      if (!token) {
        attempts.push(failedAttempt(candidate, error, "missing", options.config.tokenEnv));
        continue;
      }
    }

    const authenticated = new LmStudioClient(candidate.endpoint, {
      fetch: options.fetch,
      token,
      timeoutMs: options.timeoutMs,
    });
    try {
      const models = await authenticated.listModels(options.signal);
      const resolved = successfulResolution(
        candidate,
        "accepted",
        platform,
        options.hostname,
        authenticated,
        models,
        attempts,
      );
      if (shouldTryLanFallback(candidate, options.config, models)) {
        deferredLocal = resolved;
        continue;
      }
      return resolved;
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      const auth = isAuthenticationError(error) ? "rejected" : "unknown";
      attempts.push(failedAttempt(candidate, error, auth, options.config.tokenEnv));
    }
  }

  if (deferredLocal) {
    return { ...deferredLocal, attempts };
  }
  return { active: null, attempts, client: null, models: [] };
}

function successfulResolution(
  candidate: Candidate,
  auth: AuthState,
  platform: NodeJS.Platform,
  overrideHostname: string | undefined,
  client: LmStudioClient,
  models: ModelInfo[],
  attempts: RouteAttempt[],
): ResolvedRoute {
  attempts.push({
    kind: candidate.kind,
    endpoint: candidate.endpoint,
    auth,
    ok: true,
  });
  return {
    active: activeRoute(candidate, auth, platform, overrideHostname),
    attempts: [...attempts],
    client,
    models,
  };
}

function shouldTryLanFallback(
  candidate: Candidate,
  config: LocalHubConfig,
  models: ModelInfo[],
): boolean {
  if (candidate.kind !== "windows-lmlink" || !config.lanEndpoint) {
    return false;
  }
  const llms = models.filter((model) => model.type === "llm");
  return config.selectedModel
    ? !llms.some((model) => model.key === config.selectedModel)
    : llms.length === 0;
}

function activeRoute(
  candidate: Candidate,
  auth: AuthState,
  platform: NodeJS.Platform,
  overrideHostname?: string,
): ActiveRoute {
  return {
    kind: candidate.kind,
    endpoint: candidate.endpoint,
    auth,
    device: deviceLabel(candidate, platform, overrideHostname),
  };
}

function deviceLabel(
  candidate: Candidate,
  platform: NodeJS.Platform,
  overrideHostname?: string,
): string {
  if (candidate.kind === "mac-local") {
    return overrideHostname ?? (platform === "darwin" ? hostname() : "this Mac");
  }
  if (candidate.kind === "windows-lmlink") {
    return "LM Link preferred device (API identity unavailable)";
  }
  return new URL(candidate.endpoint).hostname;
}

function failedAttempt(
  candidate: Candidate,
  error: unknown,
  auth: AuthState,
  tokenEnv: string,
): RouteAttempt {
  if (error instanceof LmStudioError) {
    return {
      kind: candidate.kind,
      endpoint: candidate.endpoint,
      auth,
      ok: false,
      errorKind: error.kind,
      message: error.message,
      fix: fixForError(error, candidate, tokenEnv),
    };
  }
  return {
    kind: candidate.kind,
    endpoint: candidate.endpoint,
    auth,
    ok: false,
    errorKind: "host",
    message: error instanceof Error ? error.message : String(error),
    fix: "Start LM Studio and its Developer server.",
  };
}

function fixForError(error: LmStudioError, candidate: Candidate, tokenEnv: string): string {
  switch (error.kind) {
    case "authentication":
      return `Set ${tokenEnv} in this shell to a valid LM Studio API token with model permissions.`;
    case "dns":
      return `Check that ${new URL(candidate.endpoint).hostname} resolves, or use the Mac LAN IP.`;
    case "firewall":
      return `Enable Serve on Local Network and allow TCP ${endpointPort(candidate.endpoint)} through the Mac firewall.`;
    case "invalid-response":
      return "Use LM Studio 0.4.0 or newer and configure the server origin without /v1.";
    case "http":
      return error.status === 404
        ? "Use LM Studio 0.4.0 or newer and configure the server origin without /v1."
        : "Check the LM Studio server log and API permissions.";
    default:
      return candidate.kind === "windows-lan"
        ? "Start the Mac server with Serve on Local Network enabled and check its firewall."
        : "Start LM Studio's Developer server (or run `lms server start`).";
  }
}

function isAuthenticationError(error: unknown): error is LmStudioError {
  return error instanceof LmStudioError && error.kind === "authentication";
}

function isCancellationError(error: unknown): error is LmStudioError {
  return error instanceof LmStudioError && error.kind === "cancelled";
}

function endpointPort(endpoint: string): string {
  const url = new URL(endpoint);
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

export function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === "darwin" || platform === "win32";
}
