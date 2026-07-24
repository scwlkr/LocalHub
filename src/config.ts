import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_ENDPOINT,
  DEFAULT_TOKEN_ENV,
  type LocalHubConfig,
} from "./types.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_KEYS = new Set([
  "contextLength",
  "localEndpoint",
  "lanEndpoint",
  "tokenEnv",
  "selectedModel",
]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const join = platform === "win32" ? win32.join : posix.join;
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "localhub", "config.json");
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? join(userHome, "AppData", "Roaming"), "LocalHub", "config.json");
  }
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "LocalHub", "config.json");
  }
  return join(userHome, ".config", "localhub", "config.json");
}

export function defaultConfig(): LocalHubConfig {
  return {
    contextLength: DEFAULT_CONTEXT_LENGTH,
    localEndpoint: DEFAULT_ENDPOINT,
    tokenEnv: DEFAULT_TOKEN_ENV,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ConfigError(`${field} must be a positive integer.`);
  }
  return value as number;
}

export function normalizeEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be an http(s) URL.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field} must be a valid http(s) URL.`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ConfigError(`${field} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${field} must not contain credentials; use tokenEnv.`);
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ConfigError(`${field} must be a server origin without a path, query, or fragment.`);
  }

  return url.origin;
}

export function parseConfig(value: unknown): LocalHubConfig {
  if (!isObject(value)) {
    throw new ConfigError("Configuration must be a JSON object.");
  }
  const unknownKey = Object.keys(value).find((key) => !CONFIG_KEYS.has(key));
  if (unknownKey) {
    throw new ConfigError(
      `Unknown configuration key "${unknownKey}". Store API tokens only in ${DEFAULT_TOKEN_ENV}.`,
    );
  }

  const base = defaultConfig();
  const contextLength =
    value.contextLength === undefined
      ? base.contextLength
      : parsePositiveInteger(value.contextLength, "contextLength");
  const localEndpoint =
    value.localEndpoint === undefined
      ? base.localEndpoint
      : normalizeEndpoint(value.localEndpoint, "localEndpoint");
  const tokenEnv = value.tokenEnv === undefined ? base.tokenEnv : value.tokenEnv;

  if (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv)) {
    throw new ConfigError("tokenEnv must be a valid environment-variable name.");
  }

  const result: LocalHubConfig = { contextLength, localEndpoint, tokenEnv };

  if (value.lanEndpoint !== undefined && value.lanEndpoint !== null && value.lanEndpoint !== "") {
    result.lanEndpoint = normalizeEndpoint(value.lanEndpoint, "lanEndpoint");
  }
  if (value.selectedModel !== undefined && value.selectedModel !== null) {
    if (typeof value.selectedModel !== "string" || value.selectedModel.trim() === "") {
      throw new ConfigError("selectedModel must be a non-empty string.");
    }
    result.selectedModel = value.selectedModel;
  }

  return result;
}

export async function loadConfig(path = configPath()): Promise<LocalHubConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return defaultConfig();
    }
    throw new ConfigError(`Cannot read ${path}: ${errorMessage(error)}`);
  }

  try {
    return parseConfig(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Invalid JSON in ${path}: ${errorMessage(error)}`);
  }
}

export async function saveSelectedModel(
  selectedModel: string,
  current: LocalHubConfig,
  path = configPath(),
): Promise<void> {
  const next = { ...current, selectedModel };
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
