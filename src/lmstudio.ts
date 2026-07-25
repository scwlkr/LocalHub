import type {
  LmStudioErrorKind,
  LoadedInstance,
  LoadResult,
  ModelCapabilities,
  ModelInfo,
  Quantization,
} from "./types.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class LmStudioError extends Error {
  readonly kind: LmStudioErrorKind;
  readonly status?: number;

  constructor(kind: LmStudioErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LmStudioError";
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export class LmStudioClient {
  readonly endpoint: string;
  readonly hasToken: boolean;
  readonly #fetch: FetchLike;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  constructor(
    endpoint: string,
    options: {
      fetch?: FetchLike | undefined;
      token?: string | undefined;
      timeoutMs?: number | undefined;
    } = {},
  ) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#token = options.token;
    this.hasToken = Boolean(options.token);
    this.#timeoutMs = options.timeoutMs ?? 4_000;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await this.#request("/api/v1/models", { method: "GET" }, this.#timeoutMs, signal);
    return parseModelsResponse(body);
  }

  async loadModel(
    model: ModelInfo,
    contextLength: number,
    signal?: AbortSignal,
  ): Promise<LoadResult> {
    if (model.type !== "llm") {
      throw new LmStudioError("http", `${model.displayName} is not an LLM.`);
    }
    if (model.maxContextLength < contextLength) {
      throw new LmStudioError(
        "unsupported-context",
        `${model.displayName} supports ${model.maxContextLength} tokens, not ${contextLength}.`,
      );
    }

    const body = await this.#request(
      "/api/v1/models/load",
      {
        method: "POST",
        body: JSON.stringify({
          model: model.key,
          context_length: contextLength,
          echo_load_config: true,
        }),
      },
      600_000,
      signal,
    );
    return parseLoadResponse(body, contextLength);
  }

  async unloadInstance(instanceId: string, signal?: AbortSignal): Promise<string> {
    const body = await this.#request(
      "/api/v1/models/unload",
      {
        method: "POST",
        body: JSON.stringify({ instance_id: instanceId }),
      },
      60_000,
      signal,
    );
    if (!isObject(body) || typeof body.instance_id !== "string") {
      throw new LmStudioError("invalid-response", "LM Studio returned an invalid unload response.");
    }
    return body.instance_id;
  }

  async #request(
    path: string,
    init: RequestInit,
    timeoutMs = this.#timeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort();
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = (): void => reject(new Error("request aborted"));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (controller.signal.aborted) {
        rejectOnAbort();
      }
    });
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (this.#token) {
      headers.set("Authorization", `Bearer ${this.#token}`);
    }

    let response: Response;
    let text: string;
    try {
      ({ response, text } = await Promise.race([
        (async () => {
          const fetched = await this.#fetch(`${this.endpoint}${path}`, {
            ...init,
            headers,
            signal: controller.signal,
          });
          return { response: fetched, text: await fetched.text() };
        })(),
        aborted,
      ]));
    } catch (error) {
      if (signal?.aborted) {
        throw new LmStudioError("cancelled", "LM Studio operation cancelled.");
      }
      if (timedOut) {
        throw new LmStudioError("timeout", `LM Studio did not respond within ${timeoutMs} ms.`);
      }
      const kind = classifyNetworkError(error);
      throw new LmStudioError(kind, networkErrorMessage(kind, error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }

    if (!response.ok) {
      const message = parseErrorMessage(text) ?? `LM Studio returned HTTP ${response.status}.`;
      const kind: LmStudioErrorKind =
        response.status === 401 || response.status === 403 ? "authentication" : "http";
      throw new LmStudioError(kind, message, response.status);
    }

    try {
      return text === "" ? {} : (JSON.parse(text) as unknown);
    } catch {
      throw new LmStudioError("invalid-response", "LM Studio returned non-JSON data.");
    }
  }
}

export function parseModelsResponse(value: unknown): ModelInfo[] {
  if (!isObject(value) || !Array.isArray(value.models)) {
    throw new LmStudioError("invalid-response", "LM Studio models response is missing models[].");
  }
  return value.models.map((model, index) => parseModel(model, index));
}

function parseModel(value: unknown, index: number): ModelInfo {
  if (!isObject(value)) {
    throw invalidModel(index, "must be an object");
  }
  const type = value.type;
  if (type !== "llm" && type !== "embedding") {
    throw invalidModel(index, "has an invalid type");
  }

  const key = requiredString(value.key, index, "key");
  const displayName = requiredString(value.display_name, index, "display_name");
  const publisher = requiredString(value.publisher, index, "publisher");
  const sizeBytes = requiredNonNegativeNumber(value.size_bytes, index, "size_bytes");
  const maxContextLength = requiredNonNegativeNumber(
    value.max_context_length,
    index,
    "max_context_length",
  );
  if (!Number.isSafeInteger(maxContextLength)) {
    throw invalidModel(index, "max_context_length must be an integer");
  }

  if (!Array.isArray(value.loaded_instances)) {
    throw invalidModel(index, "is missing loaded_instances[]");
  }

  return {
    type,
    publisher,
    key,
    displayName,
    architecture: nullableString(value.architecture),
    quantization: parseQuantization(value.quantization, index),
    sizeBytes,
    paramsString: nullableString(value.params_string),
    loadedInstances: value.loaded_instances.map((instance, instanceIndex) =>
      parseLoadedInstance(instance, index, instanceIndex),
    ),
    maxContextLength,
    format: parseFormat(value.format, index),
    capabilities: parseCapabilities(value.capabilities, index),
    description: nullableString(value.description),
    variants: parseStringArray(value.variants),
    selectedVariant: nullableString(value.selected_variant),
  };
}

function parseLoadedInstance(
  value: unknown,
  modelIndex: number,
  instanceIndex: number,
): LoadedInstance {
  if (!isObject(value) || typeof value.id !== "string" || !isObject(value.config)) {
    throw invalidModel(modelIndex, `has an invalid loaded instance at index ${instanceIndex}`);
  }
  const contextLength = value.config.context_length;
  if (!Number.isSafeInteger(contextLength) || (contextLength as number) <= 0) {
    throw invalidModel(modelIndex, `loaded instance ${instanceIndex} has invalid context_length`);
  }

  const result: LoadedInstance = { id: value.id, contextLength: contextLength as number };
  addOptionalNumber(result, "evalBatchSize", value.config.eval_batch_size);
  addOptionalNumber(result, "parallel", value.config.parallel);
  addOptionalNumber(result, "numExperts", value.config.num_experts);
  addOptionalBoolean(result, "flashAttention", value.config.flash_attention);
  addOptionalBoolean(result, "offloadKvCacheToGpu", value.config.offload_kv_cache_to_gpu);
  return result;
}

function parseQuantization(value: unknown, index: number): Quantization | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isObject(value)) {
    throw invalidModel(index, "has invalid quantization");
  }
  const bits = value.bits_per_weight;
  if (bits !== null && bits !== undefined && typeof bits !== "number") {
    throw invalidModel(index, "has invalid quantization.bits_per_weight");
  }
  return {
    name: nullableString(value.name),
    bitsPerWeight: bits ?? null,
  };
}

function parseCapabilities(value: unknown, index: number): ModelCapabilities | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isObject(value)) {
    throw invalidModel(index, "has invalid capabilities");
  }
  let reasoning: ModelCapabilities["reasoning"] = null;
  if (value.reasoning !== null && value.reasoning !== undefined) {
    if (!isObject(value.reasoning) || !Array.isArray(value.reasoning.allowed_options)) {
      throw invalidModel(index, "has invalid capabilities.reasoning");
    }
    reasoning = {
      allowedOptions: parseStringArray(value.reasoning.allowed_options),
      default: nullableString(value.reasoning.default),
    };
  }
  return {
    vision: nullableBoolean(value.vision),
    trainedForToolUse: nullableBoolean(value.trained_for_tool_use),
    reasoning,
  };
}

export function parseLoadResponse(value: unknown, expectedContext: number): LoadResult {
  if (!isObject(value)) {
    throw new LmStudioError("invalid-response", "LM Studio returned an invalid load response.");
  }
  const instanceId =
    typeof value.instance_id === "string"
      ? value.instance_id
      : typeof value.model_instance_id === "string"
        ? value.model_instance_id
        : null;
  const type = value.type;
  if (
    !instanceId ||
    (type !== "llm" && type !== "embedding") ||
    typeof value.load_time_seconds !== "number" ||
    value.status !== "loaded"
  ) {
    throw new LmStudioError("invalid-response", "LM Studio returned an invalid load response.");
  }
  const context =
    isObject(value.load_config) && typeof value.load_config.context_length === "number"
      ? value.load_config.context_length
      : null;
  if (context === null || context < expectedContext) {
    throw new LmStudioError(
      "unsupported-context",
      `LM Studio loaded ${context ?? "an unknown context"}, below the requested minimum ${expectedContext}.`,
    );
  }
  return {
    type,
    instanceId,
    loadTimeSeconds: value.load_time_seconds,
    contextLength: context,
  };
}

export function classifyNetworkError(error: unknown): LmStudioErrorKind {
  const codes = collectErrorCodes(error);
  if (codes.some((code) => ["ENOTFOUND", "EAI_AGAIN"].includes(code))) {
    return "dns";
  }
  if (codes.some((code) => ["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code))) {
    return "firewall";
  }
  if (codes.some((code) => ["ECONNREFUSED", "ECONNRESET"].includes(code))) {
    return "host";
  }
  return "host";
}

function networkErrorMessage(kind: LmStudioErrorKind, error: unknown): string {
  const suffix = error instanceof Error && error.message ? ` ${error.message}` : "";
  switch (kind) {
    case "dns":
      return `LM Studio host name did not resolve.${suffix}`;
    case "firewall":
      return `LM Studio is unreachable or timed out.${suffix}`;
    default:
      return `Cannot connect to LM Studio.${suffix}`;
  }
}

function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string") {
      codes.push(current.code);
    }
    current = current.cause;
  }
  return codes;
}

function parseErrorMessage(text: string): string | null {
  if (!text.trim()) {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (isObject(value)) {
      if (typeof value.error === "string") {
        return value.error;
      }
      if (isObject(value.error) && typeof value.error.message === "string") {
        return value.error.message;
      }
      if (typeof value.message === "string") {
        return value.message;
      }
    }
  } catch {
    return text.trim().slice(0, 300);
  }
  return text.trim().slice(0, 300);
}

function parseFormat(value: unknown, index: number): ModelInfo["format"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (value !== "gguf" && value !== "mlx") {
    throw invalidModel(index, "has an invalid format");
  }
  return value;
}

function requiredString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw invalidModel(index, `is missing ${field}`);
  }
  return value;
}

function requiredNonNegativeNumber(value: unknown, index: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidModel(index, `has invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function addOptionalNumber<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (typeof value === "number") {
    target[key] = value as T[K];
  }
}

function addOptionalBoolean<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (typeof value === "boolean") {
    target[key] = value as T[K];
  }
}

function invalidModel(index: number, detail: string): LmStudioError {
  return new LmStudioError("invalid-response", `LM Studio model ${index} ${detail}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
