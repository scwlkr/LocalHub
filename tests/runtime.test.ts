import { describe, expect, test } from "bun:test";
import { ensureModelLoaded, unloadModel } from "../src/runtime.ts";
import { kimiModel } from "./fixtures.ts";

describe("model state operations", () => {
  test("reuses an instance already loaded at the requested context", async () => {
    const model = kimiModel({
      loadedInstances: [{ id: "ready", contextLength: 65_536 }],
    });
    const calls: string[] = [];
    const result = await ensureModelLoaded(
      {
        loadModel: async () => {
          calls.push("load");
          return { instanceId: "new" };
        },
        unloadInstance: async (id) => {
          calls.push(`unload:${id}`);
          return id;
        },
        listModels: async () => {
          calls.push("list");
          return [model];
        },
      },
      model,
      65_536,
    );
    expect(result.instanceId).toBe("ready");
    expect(result.reloaded).toBe(false);
    expect(calls).toEqual(["list"]);
  });

  test("reloads the selected model and verifies the exact context", async () => {
    const original = kimiModel({
      loadedInstances: [{ id: "old", contextLength: 8_192 }],
    });
    const refreshed = kimiModel({
      loadedInstances: [{ id: "new", contextLength: 65_536 }],
    });
    const calls: string[] = [];
    const result = await ensureModelLoaded(
      {
        unloadInstance: async (id) => {
          calls.push(`unload:${id}`);
          return id;
        },
        loadModel: async (_model, context) => {
          calls.push(`load:${context}`);
          return { instanceId: "new" };
        },
        listModels: async () => {
          calls.push("list");
          return [refreshed];
        },
      },
      original,
      65_536,
    );
    expect(result).toEqual({
      instanceId: "new",
      models: [refreshed],
      reloaded: true,
    });
    expect(calls).toEqual(["unload:old", "load:65536", "list"]);
  });

  test("fails closed when LM Studio does not confirm the loaded context", async () => {
    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => id,
          loadModel: async () => ({ instanceId: "new" }),
          listModels: async () => [kimiModel()],
        },
        kimiModel(),
        65_536,
      ),
    ).rejects.toThrow("did not confirm");
  });

  test("unloads every selected-model instance and verifies state", async () => {
    const calls: string[] = [];
    const model = kimiModel({
      loadedInstances: [
        { id: "one", contextLength: 8_192 },
        { id: "two", contextLength: 65_536 },
      ],
    });
    expect(
      await unloadModel(
        {
          unloadInstance: async (id) => {
            calls.push(id);
            return id;
          },
          loadModel: async () => ({ instanceId: "unused" }),
          listModels: async () => [kimiModel()],
        },
        model,
      ),
    ).toEqual([kimiModel()]);
    expect(calls).toEqual(["one", "two"]);
  });
});
