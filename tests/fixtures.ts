import type { ModelInfo } from "../src/types.ts";

export function kimiModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    type: "llm",
    publisher: "moonshotai",
    key: "catalog/runtime-kimi-3-q4",
    displayName: "Kimi 3",
    architecture: "kimi",
    quantization: { name: "Q4_K_M", bitsPerWeight: 4.5 },
    sizeBytes: 40_000_000_000,
    paramsString: "test-fixture",
    loadedInstances: [],
    maxContextLength: 262_144,
    format: "gguf",
    capabilities: {
      vision: false,
      trainedForToolUse: true,
      reasoning: { allowedOptions: ["on"], default: "on" },
    },
    description: "Synthetic fixture; not a hardcoded catalog entry.",
    variants: [],
    selectedVariant: null,
    ...overrides,
  };
}

export function modelsPayload(model = kimiModel()): unknown {
  return {
    models: [
      {
        type: model.type,
        publisher: model.publisher,
        key: model.key,
        display_name: model.displayName,
        architecture: model.architecture,
        quantization: model.quantization
          ? {
              name: model.quantization.name,
              bits_per_weight: model.quantization.bitsPerWeight,
            }
          : null,
        size_bytes: model.sizeBytes,
        params_string: model.paramsString,
        loaded_instances: model.loadedInstances.map((instance) => ({
          id: instance.id,
          config: {
            context_length: instance.contextLength,
            eval_batch_size: instance.evalBatchSize,
            parallel: instance.parallel,
            flash_attention: instance.flashAttention,
            num_experts: instance.numExperts,
            offload_kv_cache_to_gpu: instance.offloadKvCacheToGpu,
          },
        })),
        max_context_length: model.maxContextLength,
        format: model.format,
        capabilities: model.capabilities
          ? {
              vision: model.capabilities.vision,
              trained_for_tool_use: model.capabilities.trainedForToolUse,
              reasoning: model.capabilities.reasoning
                ? {
                    allowed_options: model.capabilities.reasoning.allowedOptions,
                    default: model.capabilities.reasoning.default,
                  }
                : undefined,
            }
          : undefined,
        description: model.description,
        variants: model.variants,
        selected_variant: model.selectedVariant,
      },
    ],
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
