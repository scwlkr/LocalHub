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

export interface EnsureModelLoadedOptions {
  pollIntervalMs?: number;
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
  options: EnsureModelLoadedOptions = {},
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
  if (model.loadedInstances.length > 0) {
    const models = await client.listModels(signal);
    const remaining =
      models.find((candidate) => candidate.key === model.key)?.loadedInstances ?? [];
    if (remaining.length > 0) {
      throw new LmStudioError(
        "invalid-response",
        `LM Studio still reports ${model.displayName} loaded; refresh and retry.`,
      );
    }
  }
  signal?.throwIfAborted();
  const operation = new AbortController();
  const abortOperation = (): void => operation.abort();
  if (signal?.aborted) {
    operation.abort();
  } else {
    signal?.addEventListener("abort", abortOperation, { once: true });
  }
  const loadAttempt: Promise<LoadRaceResult> = client
    .loadModel(model, contextLength, operation.signal)
    .then(
      (loaded) => ({ kind: "loaded", loaded }),
      (error: unknown) => ({ kind: "load-error", error }),
    );
  const observationAttempt: Promise<LoadRaceResult> = observeLoadedModel(
    client,
    model.key,
    contextLength,
    Math.max(0, options.pollIntervalMs ?? 500),
    operation.signal,
  ).then(
    (observedModel) => ({ kind: "observed", model: observedModel }),
    (error: unknown) => ({ kind: "observation-error", error }),
  );

  let winner: LoadRaceResult;
  try {
    winner = await Promise.race([loadAttempt, observationAttempt]);
  } finally {
    operation.abort();
    signal?.removeEventListener("abort", abortOperation);
  }

  if (winner.kind === "load-error") {
    if (winner.error instanceof LmStudioError && winner.error.kind === "unsupported-context") {
      const models = await client.listModels(signal).catch(() => []);
      const loadedModel = models.find((candidate) => candidate.key === model.key);
      if (loadedModel && loadedModel.loadedInstances.length > 0) {
        const unloaded = await unloadUnexpectedInstances(client, loadedModel, signal);
        throw contextMismatchError(model, loadedModel, contextLength, unloaded);
      }
    }
    throw winner.error;
  }
  if (winner.kind === "observation-error") {
    throw winner.error;
  }
  if (winner.kind === "observed") {
    const unloaded = await unloadUnexpectedInstances(client, winner.model, signal);
    throw contextMismatchError(model, winner.model, contextLength, unloaded);
  }

  const loaded = winner.loaded;
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

type LoadRaceResult =
  | { kind: "loaded"; loaded: { instanceId: string } }
  | { kind: "load-error"; error: unknown }
  | { kind: "observed"; model: ModelInfo }
  | { kind: "observation-error"; error: unknown };

async function observeLoadedModel(
  client: ModelClient,
  modelKey: string,
  contextLength: number,
  intervalMs: number,
  signal: AbortSignal,
): Promise<ModelInfo> {
  while (true) {
    await abortableDelay(intervalMs, signal);
    try {
      const models = await client.listModels(signal);
      const model = models.find((candidate) => candidate.key === modelKey);
      const hasExactContext = model?.loadedInstances.some(
        (instance) => instance.contextLength === contextLength,
      );
      if (model && model.loadedInstances.length > 0 && !hasExactContext) {
        return model;
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
    }
  }
}

async function unloadUnexpectedInstances(
  client: ModelClient,
  model: ModelInfo,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const instance of model.loadedInstances) {
    try {
      await client.unloadInstance(instance.id, signal);
    } catch {
      // The aborted load request may have already removed this instance.
    }
  }
  try {
    const models = await client.listModels(signal);
    return (
      (models.find((candidate) => candidate.key === model.key)?.loadedInstances.length ?? 0) === 0
    );
  } catch {
    return false;
  }
}

function contextMismatchError(
  requestedModel: ModelInfo,
  loadedModel: ModelInfo,
  contextLength: number,
  unloaded: boolean,
): LmStudioError {
  const contexts = [
    ...new Set(
      loadedModel.loadedInstances.map((instance) => instance.contextLength.toLocaleString("en-US")),
    ),
  ].join(", ");
  const cleanup = unloaded
    ? "The mismatched instance was unloaded."
    : "Unload the mismatched instance before retrying.";
  return new LmStudioError(
    "unsupported-context",
    `LM Studio loaded ${requestedModel.displayName} at ${contexts} instead of ${contextLength.toLocaleString("en-US")} tokens. ${cleanup} Fix: update LM Studio or its model runtime, then retry.`,
  );
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new LmStudioError("cancelled", "LM Studio operation cancelled."));
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal.aborted) {
      cancel();
    } else {
      signal.addEventListener("abort", cancel, { once: true });
    }
  });
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
