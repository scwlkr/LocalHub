import type { ModelInfo } from "../src/types.ts";

export function qwenModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    type: "llm",
    publisher: "qwen",
    key: "qwen/qwen3.6-35b-a3b",
    displayName: "Qwen3.6 35B A3B",
    architecture: "qwen3_5_moe",
    quantization: { name: "6bit", bitsPerWeight: 6 },
    sizeBytes: 29_081_792_392,
    paramsString: "35B-A3B",
    loadedInstances: [],
    maxContextLength: 262_144,
    format: "mlx",
    capabilities: {
      vision: true,
      trainedForToolUse: true,
      reasoning: { allowedOptions: ["off", "on"], default: "on" },
    },
    description: "Initial validation fixture; production discovery remains model-agnostic.",
    variants: ["lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit"],
    selectedVariant: "lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit",
    ...overrides,
  };
}

export function modelsPayload(model = qwenModel()): unknown {
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
