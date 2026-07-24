import { type LmStudioClient, LmStudioError } from "./lmstudio.ts";
import { resolveRoute } from "./routing.ts";
import { collectSystemInfo, findCodex } from "./system.ts";
import type { ActiveRoute, LocalHubConfig, ModelInfo, RouteAttempt, SystemInfo } from "./types.ts";

export interface RuntimeSnapshot {
  system: SystemInfo;
  codexPath: string | null;
  route: ActiveRoute | null;
  attempts: RouteAttempt[];
  models: ModelInfo[];
}

export interface RuntimeContext {
  snapshot: RuntimeSnapshot;
  client: LmStudioClient | null;
}

export async function collectRuntime(
  config: LocalHubConfig,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    hostname?: string;
    resolve?: typeof resolveRoute;
    which?: (command: string) => string | null;
    signal?: AbortSignal;
  } = {},
): Promise<RuntimeContext> {
  const system = collectSystemInfo(options.cwd);
  const resolve = options.resolve ?? resolveRoute;
  const [route, codexPath] = await Promise.all([
    resolve({
      config,
      hostname: options.hostname ?? system.hostname,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    Promise.resolve(findCodex(options.which)),
  ]);

  return {
    snapshot: {
      system,
      codexPath,
      route: route.active,
      attempts: route.attempts,
      models: route.models,
    },
    client: route.client,
  };
}

export interface LoadOutcome {
  instanceId: string;
  models: ModelInfo[];
  reloaded: boolean;
}

interface ModelClient {
  loadModel(
    model: ModelInfo,
    contextLength: number,
    signal?: AbortSignal,
  ): Promise<{ instanceId: string }>;
  unloadInstance(instanceId: string, signal?: AbortSignal): Promise<string>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export async function ensureModelLoaded(
  client: ModelClient,
  model: ModelInfo,
  contextLength: number,
  signal?: AbortSignal,
): Promise<LoadOutcome> {
  if (model.maxContextLength < contextLength) {
    throw new LmStudioError(
      "unsupported-context",
      `${model.displayName} supports ${model.maxContextLength} tokens, not ${contextLength}.`,
    );
  }
  const ready = model.loadedInstances.find((instance) => instance.contextLength === contextLength);
  if (ready) {
    const models = await client.listModels(signal);
    const verified = models
      .find((candidate) => candidate.key === model.key)
      ?.loadedInstances.find(
        (instance) => instance.id === ready.id && instance.contextLength === contextLength,
      );
    if (verified) {
      return { instanceId: verified.id, models, reloaded: false };
    }
    throw new LmStudioError(
      "invalid-response",
      `LM Studio no longer reports ${ready.id} at ${contextLength} tokens; refresh and retry.`,
    );
  }

  for (const instance of model.loadedInstances) {
    signal?.throwIfAborted();
    await client.unloadInstance(instance.id, signal);
  }
  signal?.throwIfAborted();
  const loaded = await client.loadModel(model, contextLength, signal);
  const models = await client.listModels(signal);
  const refreshed = models.find((candidate) => candidate.key === model.key);
  const verified = refreshed?.loadedInstances.find(
    (instance) => instance.id === loaded.instanceId && instance.contextLength === contextLength,
  );
  if (!verified) {
    throw new LmStudioError(
      "invalid-response",
      `LM Studio did not confirm ${loaded.instanceId} at ${contextLength} tokens.`,
    );
  }
  return { instanceId: verified.id, models, reloaded: model.loadedInstances.length > 0 };
}

export async function unloadModel(
  client: ModelClient,
  model: ModelInfo,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  for (const instance of model.loadedInstances) {
    signal?.throwIfAborted();
    await client.unloadInstance(instance.id, signal);
  }
  const models = await client.listModels(signal);
  const refreshed = models.find((candidate) => candidate.key === model.key);
  if (refreshed && refreshed.loadedInstances.length > 0) {
    throw new LmStudioError(
      "invalid-response",
      `LM Studio still reports ${model.displayName} loaded.`,
    );
  }
  return models;
}
