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
  contextLength: number;
  models: ModelInfo[];
  reloaded: boolean;
}

export interface EnsureModelLoadedOptions {
  pollIntervalMs?: number;
  sufficientContextStabilityMs?: number;
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
  const ready = model.loadedInstances.find((instance) => instance.contextLength >= contextLength);
  if (ready) {
    const models = await client.listModels(signal);
    const verified = models
      .find((candidate) => candidate.key === model.key)
      ?.loadedInstances.find(
        (instance) => instance.id === ready.id && instance.contextLength >= contextLength,
      );
    if (verified) {
      return {
        instanceId: verified.id,
        contextLength: verified.contextLength,
        models,
        reloaded: false,
      };
    }
    throw new LmStudioError(
      "invalid-response",
      `LM Studio no longer reports ${ready.id} with at least ${contextLength} tokens; refresh and retry.`,
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
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 500);
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
    pollIntervalMs,
    Math.max(0, options.sufficientContextStabilityMs ?? 60_000),
    operation.signal,
  ).then(
    (observation) => ({ kind: "observed", observation }),
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
      if (loadedModel?.loadedInstances.some((instance) => instance.contextLength < contextLength)) {
        const unloaded = await unloadUnexpectedInstances(
          client,
          loadedModel,
          contextLength,
          signal,
        );
        throw contextMismatchError(model, loadedModel, contextLength, unloaded);
      }
    }
    throw winner.error;
  }
  if (winner.kind === "observation-error") {
    throw winner.error;
  }
  if (winner.kind === "observed") {
    const observation = winner.observation;
    if (observation.kind === "mismatch") {
      const unloaded = await unloadUnexpectedInstances(
        client,
        observation.model,
        contextLength,
        signal,
      );
      throw contextMismatchError(model, observation.model, contextLength, unloaded);
    }
    await abortableDelay(pollIntervalMs, signal);
    const models = await client.listModels(signal);
    const verified = models
      .find((candidate) => candidate.key === model.key)
      ?.loadedInstances.find(
        (instance) =>
          instance.id === observation.instanceId && instance.contextLength >= contextLength,
      );
    if (!verified) {
      throw new LmStudioError(
        "invalid-response",
        `LM Studio removed ${observation.instanceId} after its load request was stopped; update LM Studio or its model runtime, then retry.`,
      );
    }
    return {
      instanceId: verified.id,
      contextLength: verified.contextLength,
      models,
      reloaded: model.loadedInstances.length > 0,
    };
  }

  const loaded = winner.loaded;
  const models = await client.listModels(signal);
  const refreshed = models.find((candidate) => candidate.key === model.key);
  const verified = refreshed?.loadedInstances.find(
    (instance) => instance.id === loaded.instanceId && instance.contextLength >= contextLength,
  );
  if (!verified) {
    throw new LmStudioError(
      "invalid-response",
      `LM Studio did not confirm ${loaded.instanceId} with at least ${contextLength} tokens.`,
    );
  }
  return {
    instanceId: verified.id,
    contextLength: verified.contextLength,
    models,
    reloaded: model.loadedInstances.length > 0,
  };
}

type LoadRaceResult =
  | { kind: "loaded"; loaded: { instanceId: string } }
  | { kind: "load-error"; error: unknown }
  | { kind: "observed"; observation: LoadObservation }
  | { kind: "observation-error"; error: unknown };

type LoadObservation =
  | { kind: "mismatch"; model: ModelInfo }
  | { kind: "sufficient"; instanceId: string };

async function observeLoadedModel(
  client: ModelClient,
  modelKey: string,
  contextLength: number,
  intervalMs: number,
  sufficientContextStabilityMs: number,
  signal: AbortSignal,
): Promise<LoadObservation> {
  let sufficientCandidateId: string | null = null;
  let sufficientFirstSeenAt = 0;
  while (true) {
    await abortableDelay(intervalMs, signal);
    try {
      const models = await client.listModels(signal);
      const model = models.find((candidate) => candidate.key === modelKey);
      const sufficient = model?.loadedInstances.find(
        (instance) => instance.contextLength >= contextLength,
      );
      const hasMismatch = model?.loadedInstances.some(
        (instance) => instance.contextLength < contextLength,
      );
      if (model && hasMismatch) {
        return { kind: "mismatch", model };
      }
      if (!sufficient) {
        sufficientCandidateId = null;
        continue;
      }
      const now = Date.now();
      if (sufficientCandidateId === sufficient.id) {
        if (now - sufficientFirstSeenAt >= sufficientContextStabilityMs) {
          return { kind: "sufficient", instanceId: sufficient.id };
        }
      } else {
        sufficientCandidateId = sufficient.id;
        sufficientFirstSeenAt = now;
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
  contextLength: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (const instance of model.loadedInstances.filter(
    (candidate) => candidate.contextLength < contextLength,
  )) {
    try {
      await client.unloadInstance(instance.id, signal);
    } catch {
      // The aborted load request may have already removed this instance.
    }
  }
  try {
    const models = await client.listModels(signal);
    return !models
      .find((candidate) => candidate.key === model.key)
      ?.loadedInstances.some((instance) => instance.contextLength < contextLength);
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
      loadedModel.loadedInstances
        .filter((instance) => instance.contextLength < contextLength)
        .map((instance) => instance.contextLength.toLocaleString("en-US")),
    ),
  ].join(", ");
  const cleanup = unloaded
    ? "The mismatched instance was unloaded."
    : "Unload the mismatched instance before retrying.";
  return new LmStudioError(
    "unsupported-context",
    `LM Studio loaded ${requestedModel.displayName} at only ${contexts}; LocalHub needs at least ${contextLength.toLocaleString("en-US")} tokens. ${cleanup} Fix: lower contextLength or update LM Studio, then retry.`,
  );
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(new LmStudioError("cancelled", "LM Studio operation cancelled."));
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal?.aborted) {
      cancel();
    } else {
      signal?.addEventListener("abort", cancel, { once: true });
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
