import { describe, expect, test } from "bun:test";
import {
  classifyNetworkError,
  type FetchLike,
  LmStudioClient,
  parseLoadResponse,
  parseModelsResponse,
} from "../src/lmstudio.ts";
import { jsonResponse, qwenModel, modelsPayload } from "./fixtures.ts";

describe("LM Studio API", () => {
  test("parses a synthetic Qwen3.6 catalog payload without production hardcoding", () => {
    const [model] = parseModelsResponse(modelsPayload());
    expect(model?.displayName).toBe("Qwen3.6 35B A3B");
    expect(model?.key).toBe("qwen/qwen3.6-35b-a3b");
    expect(model?.publisher).toBe("qwen");
    expect(model?.architecture).toBe("qwen3_5_moe");
    expect(model?.quantization).toEqual({ name: "6bit", bitsPerWeight: 6 });
    expect(model?.sizeBytes).toBe(29_081_792_392);
    expect(model?.paramsString).toBe("35B-A3B");
    expect(model?.maxContextLength).toBe(262_144);
    expect(model?.format).toBe("mlx");
    expect(model?.selectedVariant).toBe("lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit");
    expect(model?.capabilities?.vision).toBe(true);
    expect(model?.capabilities?.trainedForToolUse).toBe(true);
    expect(model?.capabilities?.reasoning).toEqual({
      allowedOptions: ["off", "on"],
      default: "on",
    });
  });

  test("rejects malformed model payloads", () => {
    expect(() => parseModelsResponse({ data: [] })).toThrow("missing models[]");
    expect(() => parseModelsResponse({ models: [{ type: "llm", key: "broken" }] })).toThrow(
      "display_name",
    );
  });

  test("loads with exact context and bearer auth", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const mockFetch: FetchLike = async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({
        type: "llm",
        instance_id: "loaded-qwen",
        load_time_seconds: 2.5,
        status: "loaded",
        load_config: { context_length: 65_536 },
      });
    };
    const client = new LmStudioClient("http://localhost:1234", {
      fetch: mockFetch,
      token: "ephemeral",
    });

    expect(await client.loadModel(qwenModel(), 65_536)).toEqual({
      type: "llm",
      instanceId: "loaded-qwen",
      loadTimeSeconds: 2.5,
      contextLength: 65_536,
    });
    const request = requests[0];
    expect(request?.url).toBe("http://localhost:1234/api/v1/models/load");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer ephemeral");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: "qwen/qwen3.6-35b-a3b",
      context_length: 65_536,
      echo_load_config: true,
    });
  });

  test("refuses unsupported context before network I/O", async () => {
    let called = false;
    const client = new LmStudioClient("http://localhost:1234", {
      fetch: async () => {
        called = true;
        return jsonResponse({});
      },
    });
    await expect(
      client.loadModel(qwenModel({ maxContextLength: 32_768 }), 65_536),
    ).rejects.toMatchObject({ kind: "unsupported-context" });
    expect(called).toBe(false);
  });

  test("accepts an expanded context and rejects one below the requested minimum", () => {
    expect(
      parseLoadResponse(
        {
          type: "llm",
          instance_id: "qwen",
          load_time_seconds: 1,
          status: "loaded",
          load_config: { context_length: 258_816 },
        },
        65_536,
      ),
    ).toMatchObject({ contextLength: 258_816 });
    expect(() =>
      parseLoadResponse(
        {
          type: "llm",
          instance_id: "qwen",
          load_time_seconds: 1,
          status: "loaded",
          load_config: { context_length: 8_192 },
        },
        65_536,
      ),
    ).toThrow("below the requested minimum 65536");
  });

  test("unloads by instance id", async () => {
    let body = "";
    const client = new LmStudioClient("http://localhost:1234", {
      fetch: async (_input, init) => {
        body = String(init?.body);
        return jsonResponse({ instance_id: "instance-a" });
      },
    });
    expect(await client.unloadInstance("instance-a")).toBe("instance-a");
    expect(JSON.parse(body)).toEqual({ instance_id: "instance-a" });
  });

  test("classifies authentication and network failures", async () => {
    const client = new LmStudioClient("http://localhost:1234", {
      fetch: async () => jsonResponse({ error: { message: "bad token" } }, 401),
    });
    await expect(client.listModels()).rejects.toEqual(
      expect.objectContaining({
        kind: "authentication",
        message: "bad token",
      }),
    );
    expect(classifyNetworkError(Object.assign(new Error("lookup"), { code: "ENOTFOUND" }))).toBe(
      "dns",
    );
    expect(
      classifyNetworkError(
        Object.assign(new Error("fetch failed"), {
          cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        }),
      ),
    ).toBe("firewall");
  });

  test("keeps the timeout active while reading the response body", async () => {
    const client = new LmStudioClient("http://localhost:1234", {
      timeoutMs: 10,
      fetch: async (_input, init) =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")));
            }),
        }) as Response,
    });

    await expect(client.listModels()).rejects.toMatchObject({ kind: "timeout" });
  });

  test("cancels an in-flight response body read", async () => {
    const controller = new AbortController();
    const client = new LmStudioClient("http://localhost:1234", {
      fetch: async (_input, init) =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")));
            }),
        }) as Response,
    });

    const models = client.listModels(controller.signal);
    controller.abort();
    await expect(models).rejects.toMatchObject({ kind: "cancelled" });
  });
});
