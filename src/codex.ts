const PROVIDER_ID = "localhub_lmstudio";
const CHILD_TOKEN_ENV = "LOCALHUB_LMSTUDIO_TOKEN";

export interface CodexProcessSpec {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface CodexProcessOptions {
  codexPath: string;
  modelId: string;
  endpoint: string;
  contextLength: number;
  cwd: string;
  token?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface SpawnedProcess {
  exited: Promise<number>;
}

export type SpawnCodex = (
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  },
) => SpawnedProcess;

export function buildCodexProcess(options: CodexProcessOptions): CodexProcessSpec {
  const provider: Record<string, unknown> = {
    name: "LocalHub LM Studio",
    base_url: `${options.endpoint.replace(/\/+$/, "")}/v1`,
    wire_api: "responses",
    requires_openai_auth: false,
    supports_websockets: false,
  };
  if (options.token) {
    provider.env_key = CHILD_TOKEN_ENV;
  }

  const command = [
    options.codexPath,
    "--model",
    options.modelId,
    "--cd",
    options.cwd,
    "--config",
    tomlOverride("model_provider", PROVIDER_ID),
    "--config",
    `model_context_window=${options.contextLength}`,
    "--config",
    `model_providers.${PROVIDER_ID}=${toTomlInlineTable(provider)}`,
  ];
  const env: Record<string, string | undefined> = { ...(options.baseEnv ?? process.env) };
  if (options.token) {
    env[CHILD_TOKEN_ENV] = options.token;
  } else {
    delete env[CHILD_TOKEN_ENV];
  }

  return { command, cwd: options.cwd, env };
}

export async function runCodex(
  spec: CodexProcessSpec,
  spawn: SpawnCodex = (command, options) => Bun.spawn(command, options),
): Promise<number> {
  const child = spawn(spec.command, {
    cwd: spec.cwd,
    env: spec.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function tomlOverride(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function toTomlInlineTable(values: Record<string, unknown>): string {
  const fields = Object.entries(values).map(([key, value]) => {
    if (typeof value === "string") {
      return `${key}=${JSON.stringify(value)}`;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      return `${key}=${String(value)}`;
    }
    throw new TypeError(`Unsupported TOML value for ${key}.`);
  });
  return `{ ${fields.join(", ")} }`;
}
