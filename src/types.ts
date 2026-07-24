export const DEFAULT_CONTEXT_LENGTH = 65_536;
export const DEFAULT_ENDPOINT = "http://127.0.0.1:1234";
export const DEFAULT_TOKEN_ENV = "LM_API_TOKEN";

export type SupportedPlatform = "darwin" | "win32";
export type RouteKind = "mac-local" | "windows-lmlink" | "windows-lan";
export type AuthState = "not-required" | "accepted" | "missing" | "rejected" | "unknown";

export interface LocalHubConfig {
  contextLength: number;
  localEndpoint: string;
  lanEndpoint?: string;
  tokenEnv: string;
  selectedModel?: string;
}

export interface Quantization {
  name: string | null;
  bitsPerWeight: number | null;
}

export interface ReasoningCapability {
  allowedOptions: string[];
  default: string | null;
}

export interface ModelCapabilities {
  vision: boolean | null;
  trainedForToolUse: boolean | null;
  reasoning: ReasoningCapability | null;
}

export interface LoadedInstance {
  id: string;
  contextLength: number;
  evalBatchSize?: number;
  parallel?: number;
  flashAttention?: boolean;
  numExperts?: number;
  offloadKvCacheToGpu?: boolean;
}

export interface ModelInfo {
  type: "llm" | "embedding";
  publisher: string;
  key: string;
  displayName: string;
  architecture: string | null;
  quantization: Quantization | null;
  sizeBytes: number;
  paramsString: string | null;
  loadedInstances: LoadedInstance[];
  maxContextLength: number;
  format: "gguf" | "mlx" | null;
  capabilities: ModelCapabilities | null;
  description: string | null;
  variants: string[];
  selectedVariant: string | null;
}

export interface LoadResult {
  type: "llm" | "embedding";
  instanceId: string;
  loadTimeSeconds: number;
  contextLength: number | null;
}

export interface RouteAttempt {
  kind: RouteKind;
  endpoint: string;
  auth: AuthState;
  ok: boolean;
  errorKind?: LmStudioErrorKind;
  message?: string;
  fix?: string;
}

export interface ActiveRoute {
  kind: RouteKind;
  endpoint: string;
  device: string;
  auth: AuthState;
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  hostname: string;
  cpu: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number | null;
  cwd: string;
}

export type LmStudioErrorKind =
  | "authentication"
  | "dns"
  | "firewall"
  | "host"
  | "http"
  | "invalid-response"
  | "timeout"
  | "unsupported-context";

export interface CheckResult {
  name: string;
  level: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}
