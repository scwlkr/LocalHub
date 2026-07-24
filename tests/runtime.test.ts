import { describe, expect, test } from "bun:test";
import { LmStudioError } from "../src/lmstudio.ts";
import { ensureModelLoaded, unloadModel } from "../src/runtime.ts";
import { qwenModel } from "./fixtures.ts";

describe("model state operations", () => {
  test("reuses an instance already loaded at the requested context", async () => {
    const model = qwenModel({
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
    const original = qwenModel({
      loadedInstances: [{ id: "old", contextLength: 8_192 }],
    });
    const refreshed = qwenModel({
      loadedInstances: [{ id: "new", contextLength: 65_536 }],
    });
    const calls: string[] = [];
    let listCalls = 0;
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
          listCalls += 1;
          return listCalls === 1 ? [qwenModel()] : [refreshed];
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
    expect(calls).toEqual(["unload:old", "list", "load:65536", "list"]);
  });

  test("stops a hung load when runtime inventory reports a mismatched context", async () => {
    const calls: string[] = [];
    let loadAborted = false;
    let listCalls = 0;
    const wrongContext = qwenModel({
      loadedInstances: [{ id: "wrong-context", contextLength: 258_816 }],
    });

    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => {
            calls.push(`unload:${id}`);
            return id;
          },
          loadModel: async (_model, _context, signal) =>
            await new Promise<{ instanceId: string }>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  loadAborted = true;
                  reject(new Error("cancelled"));
                },
                { once: true },
              );
            }),
          listModels: async () => {
            listCalls += 1;
            return listCalls === 1 ? [wrongContext] : [qwenModel()];
          },
        },
        qwenModel(),
        65_536,
        undefined,
        { pollIntervalMs: 0 },
      ),
    ).rejects.toMatchObject({
      kind: "unsupported-context",
      message: expect.stringContaining("258,816 instead of 65,536"),
    });
    expect(loadAborted).toBe(true);
    expect(calls).toEqual(["unload:wrong-context"]);
  });

  test("does not trust a provisional exact context while the load response hangs", async () => {
    let listCalls = 0;
    let loadAborted = false;
    const provisional = qwenModel({
      loadedInstances: [{ id: "provisional", contextLength: 65_536 }],
    });
    const wrongContext = qwenModel({
      loadedInstances: [{ id: "auto-fitted", contextLength: 258_816 }],
    });

    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => id,
          loadModel: async (_model, _context, signal) =>
            await new Promise<{ instanceId: string }>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  loadAborted = true;
                  reject(new Error("cancelled"));
                },
                { once: true },
              );
            }),
          listModels: async () => {
            listCalls += 1;
            if (listCalls === 1) {
              return [provisional];
            }
            if (listCalls === 2) {
              return [wrongContext];
            }
            return [qwenModel()];
          },
        },
        qwenModel(),
        65_536,
        undefined,
        { pollIntervalMs: 0 },
      ),
    ).rejects.toMatchObject({
      kind: "unsupported-context",
      message: expect.stringContaining("258,816 instead of 65,536"),
    });
    expect(loadAborted).toBe(true);
  });

  test("accepts a stable exact context when only the load response hangs", async () => {
    let loadAborted = false;
    const exact = qwenModel({
      loadedInstances: [{ id: "stable-exact", contextLength: 65_536 }],
    });

    const result = await ensureModelLoaded(
      {
        unloadInstance: async (id) => id,
        loadModel: async (_model, _context, signal) =>
          await new Promise<{ instanceId: string }>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                loadAborted = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          }),
        listModels: async () => [exact],
      },
      qwenModel(),
      65_536,
      undefined,
      { pollIntervalMs: 0, exactContextStabilityMs: 0 },
    );

    expect(result).toEqual({
      instanceId: "stable-exact",
      models: [exact],
      reloaded: false,
    });
    expect(loadAborted).toBe(true);
  });

  test("cleans up a mismatched context echoed by a completed load response", async () => {
    const unloaded: string[] = [];
    let listCalls = 0;
    const wrongContext = qwenModel({
      loadedInstances: [{ id: "echoed-wrong-context", contextLength: 258_816 }],
    });

    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => {
            unloaded.push(id);
            return id;
          },
          loadModel: async () => {
            throw new LmStudioError(
              "unsupported-context",
              "LM Studio loaded 258816 instead of 65536.",
            );
          },
          listModels: async () => {
            listCalls += 1;
            return listCalls === 1 ? [wrongContext] : [qwenModel()];
          },
        },
        qwenModel(),
        65_536,
      ),
    ).rejects.toMatchObject({
      kind: "unsupported-context",
      message: expect.stringContaining("mismatched instance was unloaded"),
    });
    expect(unloaded).toEqual(["echoed-wrong-context"]);
  });

  test("mismatch cleanup preserves an exact-context instance", async () => {
    const unloaded: string[] = [];
    let listCalls = 0;
    const mixed = qwenModel({
      loadedInstances: [
        { id: "keep-exact", contextLength: 65_536 },
        { id: "remove-wrong", contextLength: 258_816 },
      ],
    });
    const exactOnly = qwenModel({
      loadedInstances: [{ id: "keep-exact", contextLength: 65_536 }],
    });

    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => {
            unloaded.push(id);
            return id;
          },
          loadModel: async () => {
            throw new LmStudioError("unsupported-context", "wrong context");
          },
          listModels: async () => {
            listCalls += 1;
            return listCalls === 1 ? [mixed] : [exactOnly];
          },
        },
        qwenModel(),
        65_536,
      ),
    ).rejects.toMatchObject({ kind: "unsupported-context" });
    expect(unloaded).toEqual(["remove-wrong"]);
  });

  test("caller cancellation stops a pending load and inventory watcher", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const result = ensureModelLoaded(
      {
        unloadInstance: async (id) => id,
        loadModel: async (_model, _context, signal) =>
          await new Promise<{ instanceId: string }>((_resolve, reject) => {
            markStarted?.();
            signal?.addEventListener(
              "abort",
              () => reject(new LmStudioError("cancelled", "cancelled")),
              { once: true },
            );
          }),
        listModels: async () => [],
      },
      qwenModel(),
      65_536,
      controller.signal,
      { pollIntervalMs: 10_000 },
    );

    await started;
    controller.abort();
    await expect(result).rejects.toMatchObject({ kind: "cancelled" });
  });

  test("does not start a reload while an old instance still appears loaded", async () => {
    const original = qwenModel({
      loadedInstances: [{ id: "stale", contextLength: 8_192 }],
    });
    let loaded = false;

    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => id,
          loadModel: async () => {
            loaded = true;
            return { instanceId: "new" };
          },
          listModels: async () => [original],
        },
        original,
        65_536,
      ),
    ).rejects.toThrow("still reports Qwen3.6 35B A3B loaded");
    expect(loaded).toBe(false);
  });

  test("rejects unsupported context before unloading a working instance", async () => {
    const calls: string[] = [];
    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => {
            calls.push(`unload:${id}`);
            return id;
          },
          loadModel: async () => {
            calls.push("load");
            return { instanceId: "new" };
          },
          listModels: async () => {
            calls.push("list");
            return [];
          },
        },
        qwenModel({
          maxContextLength: 32_768,
          loadedInstances: [{ id: "working", contextLength: 32_768 }],
        }),
        65_536,
      ),
    ).rejects.toMatchObject({ kind: "unsupported-context" });
    expect(calls).toEqual([]);
  });

  test("fails closed when LM Studio does not confirm the loaded context", async () => {
    await expect(
      ensureModelLoaded(
        {
          unloadInstance: async (id) => id,
          loadModel: async () => ({ instanceId: "new" }),
          listModels: async () => [qwenModel()],
        },
        qwenModel(),
        65_536,
      ),
    ).rejects.toThrow("did not confirm");
  });

  test("unloads every selected-model instance and verifies state", async () => {
    const calls: string[] = [];
    const model = qwenModel({
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
          listModels: async () => [qwenModel()],
        },
        model,
      ),
    ).toEqual([qwenModel()]);
    expect(calls).toEqual(["one", "two"]);
  });
});
