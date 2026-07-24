import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import type { FetchLike } from "../src/lmstudio.ts";
import { resolveRoute, routeCandidates } from "../src/routing.ts";
import { jsonResponse, modelsPayload } from "./fixtures.ts";

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
});
