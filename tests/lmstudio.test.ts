import { describe, expect, test } from "bun:test";
import {
  classifyNetworkError,
  type FetchLike,
  LmStudioClient,
  parseLoadResponse,
  parseModelsResponse,
} from "../src/lmstudio.ts";
import { jsonResponse, kimiModel, modelsPayload } from "./fixtures.ts";

describe("LM Studio API", () => {
  test("parses a runtime-provided Kimi 3 model without hardcoding its key", () => {
    const [model] = parseModelsResponse(modelsPayload());
    expect(model?.displayName).toBe("Kimi 3");
    expect(model?.key).toBe("catalog/runtime-kimi-3-q4");
    expect(model?.quantization).toEqual({ name: "Q4_K_M", bitsPerWeight: 4.5 });
    expect(model?.maxContextLength).toBe(262_144);
    expect(model?.capabilities?.trainedForToolUse).toBe(true);
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
        instance_id: "loaded-kimi",
        load_time_seconds: 2.5,
        status: "loaded",
        load_config: { context_length: 65_536 },
      });
    };
    const client = new LmStudioClient("http://localhost:1234", {
      fetch: mockFetch,
      token: "ephemeral",
    });

    expect(await client.loadModel(kimiModel(), 65_536)).toEqual({
      type: "llm",
      instanceId: "loaded-kimi",
      loadTimeSeconds: 2.5,
      contextLength: 65_536,
    });
    const request = requests[0];
    expect(request?.url).toBe("http://localhost:1234/api/v1/models/load");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer ephemeral");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: "catalog/runtime-kimi-3-q4",
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
      client.loadModel(kimiModel({ maxContextLength: 32_768 }), 65_536),
    ).rejects.toMatchObject({ kind: "unsupported-context" });
    expect(called).toBe(false);
  });

  test("requires LM Studio to echo the requested context", () => {
    expect(() =>
      parseLoadResponse(
        {
          type: "llm",
          instance_id: "kimi",
          load_time_seconds: 1,
          status: "loaded",
          load_config: { context_length: 8_192 },
        },
        65_536,
      ),
    ).toThrow("loaded 8192 instead of 65536");
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
});
