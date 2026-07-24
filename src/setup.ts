import { createInterface } from "node:readline/promises";
import { normalizeEndpoint } from "./config.ts";
import { type FetchLike, LmStudioClient, LmStudioError } from "./lmstudio.ts";
import type { LocalHubConfig, ModelInfo } from "./types.ts";

const MAX_SECRET_LENGTH = 8_192;

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export interface SetupIO {
  print(message?: string): void;
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string | null>;
}

export interface SetupDependencies {
  /**
   * Receives only the validated, non-secret LocalHub configuration.
   * The CLI owns the actual persistence boundary.
   */
  saveConfig(config: LocalHubConfig): Promise<void>;
  io?: SetupIO;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  findExecutable?: (command: string) => string | null;
  runCommand?: (command: string, args: string[]) => Promise<number>;
  readLinkStatus?: (lmsPath: string) => Promise<LinkStatus>;
  probeLocal?: (config: LocalHubConfig, token?: string) => Promise<ModelInfo[]>;
  probeLan?: (endpoint: string, token: string) => Promise<ModelInfo[]>;
}

export type SetupRoute = "lmlink" | "lan";

export interface LinkStatus {
  status: string;
  issues: string[];
}

export type SetupResult =
  | {
      kind: "cancelled";
      config: LocalHubConfig;
      launch: false;
      ready: false;
    }
  | {
      kind: "incomplete";
      route?: SetupRoute;
      config: LocalHubConfig;
      launch: false;
      ready: false;
    }
  | {
      kind: "configured";
      route: SetupRoute;
      config: LocalHubConfig;
      /**
       * Present only for the lifetime of this call. The CLI may use it for the
       * immediately launched TUI/Codex process, but must never persist it.
       */
      sessionToken?: string;
      launch: boolean;
      ready: boolean;
    };

export interface HiddenInputStream {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused?(): boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data" | "end" | "error", listener: (...args: unknown[]) => void): unknown;
  off(event: "data" | "end" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface HiddenOutputStream {
  write(value: string): unknown;
}

export function createConsoleSetupIO(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): SetupIO {
  return {
    print(message = "") {
      output.write(`${message}\n`);
    },
    async ask(prompt) {
      const readline = createInterface({ input, output });
      try {
        return await readline.question(`${prompt} `);
      } finally {
        readline.close();
      }
    },
    askSecret(prompt) {
      return readHiddenInput(prompt, { input, output });
    },
  };
}

/**
 * Reads one non-echoed line and restores raw/flowing terminal state on every
 * completion path. Escape, Ctrl-C, EOF, or an empty line cancels the prompt.
 */
export async function readHiddenInput(
  prompt: string,
  options: {
    input?: HiddenInputStream;
    output?: HiddenOutputStream;
  } = {},
): Promise<string | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new SetupError("A TTY is required for hidden token input.");
  }

  const wasRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused?.() ?? false;
  output.write(`${prompt} (hidden; Enter when done, Esc to cancel): `);

  return await new Promise<string | null>((resolve, reject) => {
    let value = "";
    let settled = false;

    const cleanup = (): Error | null => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      let cleanupError: Error | null = null;
      try {
        if (!wasRaw) {
          input.setRawMode?.(false);
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error : new SetupError(String(error));
      }
      try {
        if (wasPaused) {
          input.pause();
        }
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new SetupError(String(error));
      }
      try {
        output.write("\n");
      } catch (error) {
        cleanupError ??= error instanceof Error ? error : new SetupError(String(error));
      }
      return cleanupError;
    };
    const finish = (result: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      const cleanupError = cleanup();
      if (cleanupError) {
        reject(cleanupError);
      } else {
        resolve(result);
      }
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new SetupError(String(error)));
    };
    const onData = (chunk: unknown): void => {
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString("utf8")
            : String(chunk);
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish(value === "" ? null : value);
          return;
        }
        if (character === "\u001b" || character === "\u0003") {
          finish(null);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) {
          continue;
        }
        if (value.length >= MAX_SECRET_LENGTH) {
          fail(new SetupError("API token is unexpectedly long."));
          return;
        }
        value += character;
      }
    };
    const onEnd = (): void => finish(null);
    const onError = (error: unknown): void => fail(error);

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    try {
      if (!wasRaw) {
        input.setRawMode?.(true);
      }
      input.resume();
    } catch (error) {
      fail(error);
    }
  });
}

export async function runSetup(
  currentConfig: LocalHubConfig,
  configFile: string,
  dependencies: SetupDependencies,
): Promise<SetupResult> {
  const io = dependencies.io ?? createConsoleSetupIO();
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const env = dependencies.env ?? process.env;
  const findExecutable = dependencies.findExecutable ?? Bun.which;
  const runCommand = dependencies.runCommand ?? runSetupCommand;
  const readLinkStatus = dependencies.readLinkStatus ?? getLinkStatus;
  const probeLocal = dependencies.probeLocal ?? probeLocalEndpoint;
  const probeLan = dependencies.probeLan ?? probeAuthenticatedLan;

  io.print("LocalHub Windows setup");
  io.print(`Config: ${configFile}`);
  if (platform !== "win32" || arch !== "x64") {
    io.print(`This wizard requires Windows x64; found ${platform} ${arch}.`);
    return incomplete(currentConfig);
  }

  const codexPath = findExecutable("codex");
  const codexReady =
    codexPath !== null && (await runCommand(codexPath, ["--version"]).catch(() => 1)) === 0;
  io.print(
    codexReady
      ? `PASS Codex: ${codexPath}`
      : "FAIL Codex: install Codex and confirm `codex --version` works.",
  );

  let localModels: ModelInfo[] | null = null;
  const localToken = env[currentConfig.tokenEnv];
  try {
    localModels = await probeLocal(currentConfig, localToken);
    io.print(`PASS Windows local API: ${llmCount(localModels)} LLM(s) visible.`);
  } catch (error) {
    io.print(`WARN Windows local API: ${safeError(error, localToken)}`);
  }

  const route = await askRoute(io);
  if (!route) {
    return cancelled(currentConfig);
  }
  if (route === "lmlink") {
    return await configureLmLink({
      currentConfig,
      io,
      localModels,
      codexReady,
      findExecutable,
      runCommand,
      readLinkStatus,
      probeLocal,
      saveConfig: dependencies.saveConfig,
    });
  }
  return await configureLan({
    currentConfig,
    io,
    codexReady,
    env,
    probeLan,
    saveConfig: dependencies.saveConfig,
  });
}

export async function probeLocalEndpoint(
  config: LocalHubConfig,
  token?: string,
): Promise<ModelInfo[]> {
  const anonymous = new LmStudioClient(config.localEndpoint);
  try {
    return await anonymous.listModels();
  } catch (error) {
    if (!token || !(error instanceof LmStudioError) || error.kind !== "authentication") {
      throw error;
    }
  }
  return await new LmStudioClient(config.localEndpoint, { token }).listModels();
}

/**
 * Direct LAN is accepted only when anonymous inventory is rejected and the
 * same inventory succeeds with the supplied bearer token.
 */
export async function probeAuthenticatedLan(
  endpoint: string,
  token: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<ModelInfo[]> {
  if (token === "") {
    throw new SetupError("An LM Studio API token is required.");
  }
  const anonymous = new LmStudioClient(endpoint, options);
  try {
    await anonymous.listModels();
  } catch (error) {
    if (error instanceof LmStudioError && error.kind === "authentication") {
      return await new LmStudioClient(endpoint, { ...options, token }).listModels();
    }
    throw error;
  }
  throw new SetupError(
    "The Mac server accepted an anonymous request. Enable Require Authentication before using direct LAN.",
  );
}

async function configureLmLink(options: {
  currentConfig: LocalHubConfig;
  io: SetupIO;
  localModels: ModelInfo[] | null;
  codexReady: boolean;
  findExecutable: (command: string) => string | null;
  runCommand: (command: string, args: string[]) => Promise<number>;
  readLinkStatus: (lmsPath: string) => Promise<LinkStatus>;
  probeLocal: (config: LocalHubConfig, token?: string) => Promise<ModelInfo[]>;
  saveConfig: (config: LocalHubConfig) => Promise<void>;
}): Promise<SetupResult> {
  const lmsPath = options.findExecutable("lms");
  if (!lmsPath) {
    options.io.print(
      "LM Studio CLI is missing. Install/open LM Studio once, then confirm `lms --help` works.",
    );
    return incomplete(options.currentConfig, "lmlink");
  }

  let linkReady = false;
  try {
    const status = await options.readLinkStatus(lmsPath);
    linkReady = status.status === "online" && !status.issues.includes("notLoggedIn");
  } catch (error) {
    options.io.print(`Could not read LM Link status: ${safeError(error)}`);
  }
  if (!linkReady) {
    const proceed = await askYesNo(options.io, "Run LM Link sign-in and enablement now?", true);
    if (!proceed) {
      options.io.print("LM Link setup paused. Run `lh setup` when ready.");
      return incomplete(options.currentConfig, "lmlink");
    }
    for (const command of [
      { command: "login", args: [] },
      { command: "link", args: ["enable"] },
    ]) {
      const code = await options
        .runCommand(lmsPath, [command.command, ...command.args])
        .catch(() => 1);
      if (code !== 0) {
        options.io.print(`LM Studio command failed: lms ${command.command}.`);
        return incomplete(options.currentConfig, "lmlink");
      }
    }
  }

  if (
    await askYesNo(
      options.io,
      "Choose/confirm the inference Mac as the preferred device now?",
      true,
    )
  ) {
    const preferredCode = await options
      .runCommand(lmsPath, ["link", "set-preferred-device"])
      .catch(() => 1);
    if (preferredCode !== 0) {
      options.io.print(
        "Could not confirm the preferred device. Re-run `lms link set-preferred-device`.",
      );
    }
  }

  let models = options.localModels;
  try {
    models = await options.probeLocal(options.currentConfig);
  } catch (error) {
    options.io.print(`Windows local API is not ready: ${safeError(error)}`);
  }
  if (
    models === null &&
    (await askYesNo(options.io, "Start the Windows LM Studio API server now?", true))
  ) {
    const serverCode = await options
      .runCommand(lmsPath, ["server", "start", "--port", "1234"])
      .catch(() => 1);
    if (serverCode === 0) {
      try {
        models = await options.probeLocal(options.currentConfig);
      } catch (error) {
        options.io.print(`LM Link API check failed: ${safeError(error)}`);
      }
    } else {
      options.io.print("Could not start the Windows LM Studio API server.");
    }
  }

  if (models === null) {
    options.io.print(
      "LM Link is not reachable. Keep the Mac online, start both LM Studio servers, and retry.",
    );
    return incomplete(options.currentConfig, "lmlink");
  }
  const selection = await chooseModel(options.io, models, options.currentConfig);
  if (selection === "cancelled") {
    return cancelled(options.currentConfig);
  }
  const nextConfig = selection
    ? { ...options.currentConfig, selectedModel: selection.key }
    : { ...options.currentConfig };
  await options.saveConfig(nextConfig);
  options.io.print("Saved non-secret settings.");
  options.io.print(
    "LM Studio's REST response cannot prove device placement; confirm the Mac is preferred.",
  );
  return await finishSetup(options.io, "lmlink", nextConfig, selection, options.codexReady);
}

async function configureLan(options: {
  currentConfig: LocalHubConfig;
  io: SetupIO;
  codexReady: boolean;
  env: NodeJS.ProcessEnv;
  probeLan: (endpoint: string, token: string) => Promise<ModelInfo[]>;
  saveConfig: (config: LocalHubConfig) => Promise<void>;
}): Promise<SetupResult> {
  options.io.print(
    "On the Mac: enable Serve on Local Network, enable Require Authentication, and create an API token.",
  );
  const endpoint = await askEndpoint(options.io, options.currentConfig.lanEndpoint);
  if (!endpoint) {
    return cancelled(options.currentConfig);
  }

  let token = "";
  const currentToken = processToken(options.env, options.currentConfig.tokenEnv);
  if (currentToken) {
    token = currentToken;
    options.io.print(`Using ${options.currentConfig.tokenEnv} from this process.`);
  } else {
    token = (await options.io.askSecret("LM Studio API token")) ?? "";
  }
  if (!token) {
    options.io.print("Token entry cancelled; nothing was saved.");
    return cancelled(options.currentConfig);
  }

  let models: ModelInfo[];
  try {
    models = await options.probeLan(endpoint, token);
  } catch (error) {
    options.io.print(`Direct LAN check failed: ${safeError(error, token)}`);
    options.io.print("Nothing was saved. Fix the Mac server/authentication and retry.");
    return incomplete(options.currentConfig, "lan");
  }
  options.io.print(`PASS Direct LAN authentication: ${llmCount(models)} LLM(s) visible.`);

  const selection = await chooseModel(options.io, models, options.currentConfig);
  if (selection === "cancelled") {
    return cancelled(options.currentConfig);
  }
  const nextConfig: LocalHubConfig = {
    ...options.currentConfig,
    lanEndpoint: endpoint,
    ...(selection ? { selectedModel: selection.key } : {}),
  };
  await options.saveConfig(nextConfig);
  options.io.print("Saved endpoint and model preference. The API token was not saved.");
  return await finishSetup(options.io, "lan", nextConfig, selection, options.codexReady, token);
}

async function finishSetup(
  io: SetupIO,
  route: SetupRoute,
  config: LocalHubConfig,
  selected: ModelInfo | null,
  codexReady: boolean,
  sessionToken?: string,
): Promise<SetupResult> {
  if (!selected) {
    io.print("No LLM is visible. Install a tool-capable model on the Mac, then rerun setup.");
    return configured(route, config, false, false, sessionToken);
  }
  if (selected.maxContextLength < config.contextLength) {
    io.print(
      `${selected.displayName} supports ${selected.maxContextLength.toLocaleString("en-US")} tokens, not ${config.contextLength.toLocaleString("en-US")}.`,
    );
    io.print("Choose a larger-context model or lower contextLength, then rerun setup.");
    return configured(route, config, false, false, sessionToken);
  }
  if (!codexReady) {
    io.print("Setup is saved, but Codex must be installed before launch.");
    return configured(route, config, false, false, sessionToken);
  }

  const launch = await askYesNo(io, "Launch LocalHub now?", true);
  return configured(route, config, true, launch, sessionToken);
}

async function askRoute(io: SetupIO): Promise<SetupRoute | null> {
  io.print("");
  io.print("Choose how Windows reaches the inference Mac:");
  io.print("  1) LM Link (encrypted; LM Studio sign-in)");
  io.print("  2) Authenticated direct LAN (no LM Link required; trusted LAN only)");
  for (;;) {
    const answer = (await io.ask("Route [1, 2, q; default 1]:")).trim().toLowerCase();
    if (answer === "" || answer === "1") {
      return "lmlink";
    }
    if (answer === "2") {
      return "lan";
    }
    if (answer === "q" || answer === "quit") {
      return null;
    }
    io.print("Enter 1, 2, or q.");
  }
}

async function askEndpoint(io: SetupIO, current?: string): Promise<string | null> {
  for (;;) {
    const suffix = current ? ` [${current}]` : "";
    const answer = (await io.ask(`Mac LM Studio origin${suffix}:`)).trim();
    if (answer.toLowerCase() === "q") {
      return null;
    }
    const value = answer || current;
    if (!value) {
      io.print("Enter an origin such as http://macbook.local:1234, or q to cancel.");
      continue;
    }
    try {
      return normalizeEndpoint(value, "lanEndpoint");
    } catch (error) {
      io.print(safeError(error));
    }
  }
}

async function chooseModel(
  io: SetupIO,
  models: ModelInfo[],
  config: LocalHubConfig,
): Promise<ModelInfo | null | "cancelled"> {
  const llms = models.filter((model) => model.type === "llm");
  if (llms.length === 0) {
    return null;
  }
  const preferredIndex = Math.max(
    0,
    llms.findIndex((model) => model.key === config.selectedModel),
  );
  io.print("");
  io.print("Available LLMs:");
  for (const [index, model] of llms.entries()) {
    const tools = model.capabilities?.trainedForToolUse === true ? "tools" : "tool support unknown";
    io.print(
      `  ${index + 1}) ${model.displayName} · max ${model.maxContextLength.toLocaleString("en-US")} · ${tools}`,
    );
  }
  for (;;) {
    const answer = (await io.ask(`Model [${preferredIndex + 1}, q to cancel]:`))
      .trim()
      .toLowerCase();
    if (answer === "q" || answer === "quit") {
      return "cancelled";
    }
    const index = answer === "" ? preferredIndex : Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < llms.length) {
      return llms[index] ?? null;
    }
    io.print(`Enter a number from 1 to ${llms.length}, or q.`);
  }
}

async function askYesNo(io: SetupIO, prompt: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]:" : "[y/N]:";
  for (;;) {
    const answer = (await io.ask(`${prompt} ${hint}`)).trim().toLowerCase();
    if (answer === "") {
      return defaultYes;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    io.print("Enter y or n.");
  }
}

function configured(
  route: SetupRoute,
  config: LocalHubConfig,
  ready: boolean,
  launch: boolean,
  sessionToken?: string,
): SetupResult {
  return {
    kind: "configured",
    route,
    config,
    ready,
    launch,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function cancelled(config: LocalHubConfig): SetupResult {
  return { kind: "cancelled", config, ready: false, launch: false };
}

function incomplete(config: LocalHubConfig, route?: SetupRoute): SetupResult {
  return {
    kind: "incomplete",
    config,
    ready: false,
    launch: false,
    ...(route ? { route } : {}),
  };
}

function llmCount(models: ModelInfo[]): number {
  return models.filter((model) => model.type === "llm").length;
}

function processToken(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === "" ? undefined : value;
}

function safeError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.split(secret).join("[redacted]") : message;
}

async function runSetupCommand(command: string, args: string[]): Promise<number> {
  return await Bun.spawn([command, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

export async function getLinkStatus(lmsPath: string): Promise<LinkStatus> {
  const child = Bun.spawn([lmsPath, "link", "status", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new SetupError(stderr.trim() || `lms link status exited ${code}.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new SetupError("LM Studio returned invalid LM Link status JSON.");
  }
  return parseLinkStatus(value);
}

export function parseLinkStatus(value: unknown): LinkStatus {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !("issues" in value) ||
    !Array.isArray(value.issues) ||
    !value.issues.every((issue) => typeof issue === "string")
  ) {
    throw new SetupError("LM Studio returned an invalid LM Link status.");
  }
  return { status: value.status, issues: value.issues };
}
