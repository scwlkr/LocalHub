import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import type { FetchLike } from "../src/lmstudio.ts";
import { resolveRoute, routeCandidates } from "../src/routing.ts";
import { jsonResponse, kimiModel, modelsPayload } from "./fixtures.ts";

describe("routing", () => {
  test("macOS only targets the local server", () => {
    expect(
      routeCandidates("darwin", {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
      }),
    ).toEqual([
      {
        kind: "mac-local",
        endpoint: "http://127.0.0.1:1234",
        tokenRequired: false,
      },
    ]);
  });

  test("Windows tries LM Link locally before authenticated direct LAN", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const mockFetch: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("Authorization") });
      if (String(input).startsWith("http://127.0.0.1")) {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      }
      if (!headers.has("Authorization")) {
        return jsonResponse({ error: "required" }, 401);
      }
      return jsonResponse(modelsPayload());
    };

    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
      },
      env: { LM_API_TOKEN: "secret" },
      fetch: mockFetch,
    });

    expect(resolved.active).toEqual({
      kind: "windows-lan",
      endpoint: "http://macbook.local:1234",
      device: "macbook.local",
      auth: "accepted",
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:1234/api/v1/models",
        auth: null,
      },
      {
        url: "http://macbook.local:1234/api/v1/models",
        auth: null,
      },
      {
        url: "http://macbook.local:1234/api/v1/models",
        auth: "Bearer secret",
      },
    ]);
  });

  test("never attempts direct LAN without a token", async () => {
    const calls: string[] = [];
    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
      },
      env: {},
      fetch: async (input) => {
        calls.push(String(input));
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      },
    });

    expect(resolved.active).toBeNull();
    expect(calls).toEqual(["http://127.0.0.1:1234/api/v1/models"]);
    expect(resolved.attempts[1]).toEqual(
      expect.objectContaining({
        kind: "windows-lan",
        auth: "missing",
        errorKind: "authentication",
      }),
    );
  });

  test("retries an authenticated local endpoint after a 401", async () => {
    const authHeaders: Array<string | null> = [];
    const resolved = await resolveRoute({
      platform: "darwin",
      config: defaultConfig(),
      env: { LM_API_TOKEN: "valid" },
      fetch: async (_input, init) => {
        const auth = new Headers(init?.headers).get("Authorization");
        authHeaders.push(auth);
        return auth ? jsonResponse(modelsPayload()) : jsonResponse({ error: "required" }, 401);
      },
      hostname: "studio-mac",
    });
    expect(authHeaders).toEqual([null, "Bearer valid"]);
    expect(resolved.active?.auth).toBe("accepted");
    expect(resolved.active?.device).toBe("studio-mac");
  });

  test("Windows falls back to direct LAN when the local endpoint has no LLM", async () => {
    const calls: string[] = [];
    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
      },
      env: { LM_API_TOKEN: "secret" },
      fetch: async (input, init) => {
        calls.push(String(input));
        if (String(input).startsWith("http://127.0.0.1")) {
          return jsonResponse({ models: [] });
        }
        return new Headers(init?.headers).has("Authorization")
          ? jsonResponse(modelsPayload())
          : jsonResponse({ error: "required" }, 401);
      },
    });

    expect(resolved.active?.kind).toBe("windows-lan");
    expect(resolved.models[0]?.displayName).toBe("Kimi 3");
    expect(calls).toEqual([
      "http://127.0.0.1:1234/api/v1/models",
      "http://macbook.local:1234/api/v1/models",
      "http://macbook.local:1234/api/v1/models",
    ]);
  });

  test("Windows falls back to direct LAN when the preferred model is not local", async () => {
    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        selectedModel: "catalog/runtime-kimi-3-q4",
        lanEndpoint: "http://macbook.local:1234",
      },
      env: { LM_API_TOKEN: "secret" },
      fetch: async (input, init) => {
        if (String(input).startsWith("http://127.0.0.1")) {
          return jsonResponse(modelsPayload(kimiModel({ key: "local/other-model" })));
        }
        return new Headers(init?.headers).has("Authorization")
          ? jsonResponse(modelsPayload())
          : jsonResponse({ error: "required" }, 401);
      },
    });

    expect(resolved.active?.kind).toBe("windows-lan");
    expect(resolved.models[0]?.key).toBe("catalog/runtime-kimi-3-q4");
  });

  test("keeps a reachable local endpoint when LAN fallback is unavailable", async () => {
    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
      },
      env: {},
      fetch: async () => jsonResponse({ models: [] }),
    });

    expect(resolved.active?.kind).toBe("windows-lmlink");
    expect(resolved.models).toEqual([]);
    expect(resolved.attempts).toEqual([
      expect.objectContaining({ kind: "windows-lmlink", ok: true }),
      expect.objectContaining({
        kind: "windows-lan",
        ok: false,
        auth: "missing",
      }),
    ]);
  });

  test("rejects a direct-LAN server that accepts anonymous requests", async () => {
    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
      },
      env: { LM_API_TOKEN: "secret" },
      fetch: async (input) => {
        if (String(input).startsWith("http://127.0.0.1")) {
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        }
        return jsonResponse(modelsPayload());
      },
    });

    expect(resolved.active).toBeNull();
    expect(resolved.attempts.at(-1)).toEqual(
      expect.objectContaining({
        kind: "windows-lan",
        auth: "not-required",
        ok: false,
        message: "Direct-LAN server accepted an unauthenticated request.",
        fix: expect.stringContaining("Enable Require Authentication"),
      }),
    );
  });

  test("reports the protocol default port in firewall fixes", async () => {
    const resolved = await resolveRoute({
      platform: "win32",
      config: {
        ...defaultConfig(),
        lanEndpoint: "https://macbook.local",
      },
      env: { LM_API_TOKEN: "secret" },
      fetch: async (input) => {
        throw Object.assign(new Error("unreachable"), {
          code: String(input).startsWith("https://") ? "ETIMEDOUT" : "ECONNREFUSED",
        });
      },
    });

    expect(resolved.attempts.at(-1)?.fix).toContain("TCP 443");
  });
});
