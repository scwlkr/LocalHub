import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { defaultConfig } from "../src/config.ts";
import {
  type HiddenInputStream,
  parseLinkStatus,
  probeAuthenticatedLan,
  readHiddenInput,
  runSetup,
  type SetupIO,
} from "../src/setup.ts";
import type { LocalHubConfig } from "../src/types.ts";
import { jsonResponse, kimiModel, modelsPayload } from "./fixtures.ts";

describe("setup wizard", () => {
  test("configures direct LAN, persists no secret, and returns a launch-only token", async () => {
    const secret = "top-secret-token";
    const io = new ScriptedIO(["2", "http://macbook.local:1234", "", ""], [secret]);
    const saved: LocalHubConfig[] = [];
    const commands: string[][] = [];

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      env: {},
      io,
      findExecutable: (command) => (command === "codex" ? "C:\\bin\\codex.exe" : null),
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        return 0;
      },
      probeLocal: async () => {
        throw new Error("offline");
      },
      probeLan: async (endpoint, token) => {
        expect(endpoint).toBe("http://macbook.local:1234");
        expect(token).toBe(secret);
        return [kimiModel()];
      },
      saveConfig: async (config) => {
        saved.push(structuredClone(config));
      },
    });

    expect(commands).toEqual([["C:\\bin\\codex.exe", "--version"]]);
    expect(saved).toEqual([
      {
        ...defaultConfig(),
        lanEndpoint: "http://macbook.local:1234",
        selectedModel: "catalog/runtime-kimi-3-q4",
      },
    ]);
    const savedConfig = saved[0];
    if (!savedConfig) {
      throw new Error("Expected setup to save a configuration.");
    }
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(io.output.join("\n")).not.toContain(secret);
    expect(result).toEqual({
      kind: "configured",
      route: "lan",
      config: savedConfig,
      sessionToken: secret,
      ready: true,
      launch: true,
    });
  });

  test("uses an injected process token without asking for or persisting it", async () => {
    const secret = "session-only";
    const io = new ScriptedIO(["2", "http://10.0.0.8:1234", "", "n"], []);
    const saved: LocalHubConfig[] = [];

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      env: { LM_API_TOKEN: secret },
      io,
      findExecutable: (command) => (command === "codex" ? "codex.exe" : null),
      runCommand: async () => 0,
      probeLocal: async () => [],
      probeLan: async (_endpoint, token) => {
        expect(token).toBe(secret);
        return [kimiModel()];
      },
      saveConfig: async (config) => {
        saved.push(structuredClone(config));
      },
    });

    expect(io.secretPrompts).toEqual([]);
    expect(result).toEqual(
      expect.objectContaining({
        kind: "configured",
        sessionToken: secret,
        launch: false,
        ready: true,
      }),
    );
    expect(JSON.stringify(saved)).not.toContain(secret);
  });

  test("redacts a rejected token and does not save failed LAN settings", async () => {
    const secret = "never-print-this";
    const io = new ScriptedIO(["2", "http://macbook.local:1234"], [secret]);
    let saves = 0;

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      env: {},
      io,
      findExecutable: () => null,
      probeLocal: async () => [],
      probeLan: async () => {
        throw new Error(`Token ${secret} was rejected.`);
      },
      saveConfig: async () => {
        saves += 1;
      },
    });

    expect(saves).toBe(0);
    expect(io.output.join("\n")).toContain("Token [redacted] was rejected.");
    expect(io.output.join("\n")).not.toContain(secret);
    expect(result).toEqual({
      kind: "incomplete",
      route: "lan",
      config: defaultConfig(),
      ready: false,
      launch: false,
    });
  });

  test("walks through LM Link commands, starts the API, and selects the Mac model", async () => {
    const io = new ScriptedIO(["1", "", "", "", "", ""], []);
    const calls: string[][] = [];
    const saved: LocalHubConfig[] = [];
    let probes = 0;

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      env: {},
      io,
      findExecutable: (command) => `C:\\bin\\${command}.exe`,
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return 0;
      },
      readLinkStatus: async () => ({ status: "offline", issues: ["notLoggedIn"] }),
      probeLocal: async () => {
        probes += 1;
        if (probes < 3) {
          throw new Error("server offline");
        }
        return [kimiModel()];
      },
      saveConfig: async (config) => {
        saved.push(structuredClone(config));
      },
    });

    expect(calls).toEqual([
      ["C:\\bin\\codex.exe", "--version"],
      ["C:\\bin\\lms.exe", "login"],
      ["C:\\bin\\lms.exe", "link", "enable"],
      ["C:\\bin\\lms.exe", "link", "set-preferred-device"],
      ["C:\\bin\\lms.exe", "server", "start", "--port", "1234"],
    ]);
    expect(saved[0]?.selectedModel).toBe("catalog/runtime-kimi-3-q4");
    expect(result).toEqual(
      expect.objectContaining({
        kind: "configured",
        route: "lmlink",
        ready: true,
        launch: true,
      }),
    );
    expect(result).not.toHaveProperty("sessionToken");
  });

  test("trusts JSON LM Link status and does not repeat login when already online", async () => {
    const io = new ScriptedIO(["1", "n", "", "n"], []);
    const calls: string[][] = [];

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      io,
      findExecutable: (command) => `C:\\bin\\${command}.exe`,
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return 0;
      },
      readLinkStatus: async () => ({ status: "online", issues: [] }),
      probeLocal: async () => [kimiModel()],
      saveConfig: async () => undefined,
    });

    expect(calls).toEqual([["C:\\bin\\codex.exe", "--version"]]);
    expect(result).toEqual(
      expect.objectContaining({
        kind: "configured",
        route: "lmlink",
        ready: true,
        launch: false,
      }),
    );
  });

  test("cancelling route selection performs no writes", async () => {
    const io = new ScriptedIO(["q"], []);
    let saves = 0;

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      io,
      findExecutable: () => null,
      probeLocal: async () => [],
      saveConfig: async () => {
        saves += 1;
      },
    });

    expect(saves).toBe(0);
    expect(result).toEqual({
      kind: "cancelled",
      config: defaultConfig(),
      ready: false,
      launch: false,
    });
  });

  test("saves an unsupported-context choice but does not offer launch", async () => {
    const io = new ScriptedIO(["2", "http://macbook.local:1234", ""], ["temporary"]);
    const prompts: string[] = [];
    const originalAsk = io.ask.bind(io);
    io.ask = async (prompt) => {
      prompts.push(prompt);
      return await originalAsk(prompt);
    };

    const result = await runSetup(defaultConfig(), "C:\\config.json", {
      platform: "win32",
      arch: "x64",
      env: {},
      io,
      findExecutable: () => "codex.exe",
      runCommand: async () => 0,
      probeLocal: async () => [],
      probeLan: async () => [kimiModel({ maxContextLength: 32_768 })],
      saveConfig: async () => undefined,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "configured",
        ready: false,
        launch: false,
      }),
    );
    expect(prompts.some((prompt) => prompt.startsWith("Launch LocalHub"))).toBe(false);
    expect(io.output.join("\n")).toContain("supports 32,768 tokens, not 65,536");
  });
});

describe("LM Link status parsing", () => {
  test("recognizes the official logged-out JSON state", () => {
    expect(
      parseLinkStatus({
        status: "offline",
        issues: ["notLoggedIn"],
        peers: [],
        deviceIdentifier: null,
      }),
    ).toEqual({ status: "offline", issues: ["notLoggedIn"] });
  });

  test("rejects malformed status JSON", () => {
    expect(() => parseLinkStatus({ status: "offline", issues: [42] })).toThrow(
      "invalid LM Link status",
    );
  });
});

describe("authenticated direct-LAN probe", () => {
  test("requires anonymous rejection before sending the bearer token", async () => {
    const authorizations: Array<string | null> = [];
    const models = await probeAuthenticatedLan("http://macbook.local:1234", "secret", {
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        authorizations.push(authorization);
        return authorization
          ? jsonResponse(modelsPayload())
          : jsonResponse({ error: "authentication required" }, 401);
      },
    });

    expect(authorizations).toEqual([null, "Bearer secret"]);
    expect(models[0]?.displayName).toBe("Kimi 3");
  });

  test("refuses an anonymously accessible Mac without exposing the token", async () => {
    const authorizations: Array<string | null> = [];
    const promise = probeAuthenticatedLan("http://macbook.local:1234", "secret", {
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return jsonResponse(modelsPayload());
      },
    });

    await expect(promise).rejects.toThrow("Enable Require Authentication");
    expect(authorizations).toEqual([null]);
  });
});

describe("hidden token input", () => {
  test("does not echo input and restores raw and paused state", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const result = readHiddenInput("Token", { input, output });

    input.emit("data", Buffer.from("secrex\u007ft\r"));

    expect(await result).toBe("secret");
    expect(output.values.join("")).not.toContain("secret");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.resumeCalls).toBe(1);
    expect(input.pauseCalls).toBe(1);
    expect(input.isPaused()).toBe(true);
  });

  test("Ctrl-C cancels and still restores the terminal", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const result = readHiddenInput("Token", { input, output });

    input.emit("data", Buffer.from("partial\u0003"));

    expect(await result).toBeNull();
    expect(input.rawModes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
    expect(output.values.at(-1)).toBe("\n");
  });

  test("input errors reject after restoring the terminal", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const result = readHiddenInput("Token", { input, output });

    input.emit("error", new Error("console closed"));

    await expect(result).rejects.toThrow("console closed");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
    expect(output.values.at(-1)).toBe("\n");
  });
});

class ScriptedIO implements SetupIO {
  readonly output: string[] = [];
  readonly secretPrompts: string[] = [];

  constructor(
    private readonly answers: string[],
    private readonly secrets: Array<string | null>,
  ) {}

  print(message = ""): void {
    this.output.push(message);
  }

  async ask(prompt: string): Promise<string> {
    this.output.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) {
      throw new Error(`No scripted answer for: ${prompt}`);
    }
    return answer;
  }

  async askSecret(prompt: string): Promise<string | null> {
    this.secretPrompts.push(prompt);
    const secret = this.secrets.shift();
    if (secret === undefined) {
      throw new Error(`No scripted secret for: ${prompt}`);
    }
    return secret;
  }
}

class FakeInput extends EventEmitter implements HiddenInputStream {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  resumeCalls = 0;
  pauseCalls = 0;
  private paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    this.isRaw = mode;
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    this.paused = false;
    return this;
  }

  pause(): this {
    this.pauseCalls += 1;
    this.paused = true;
    return this;
  }
}

class FakeOutput {
  readonly values: string[] = [];

  write(value: string): boolean {
    this.values.push(value);
    return true;
  }
}
