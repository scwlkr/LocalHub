import type { RuntimeSnapshot } from "./runtime.ts";

export type Operation = "refresh" | "load" | "unload" | "diagnostics";

export interface TuiState {
  phase: "starting" | "ready" | "busy" | "error";
  snapshot: RuntimeSnapshot | null;
  selectedModel: string | null;
  operation: Operation | null;
  message: string;
}

export type TuiEvent =
  | { type: "refresh-started" }
  | { type: "refresh-succeeded"; snapshot: RuntimeSnapshot }
  | { type: "operation-started"; operation: Exclude<Operation, "refresh">; message: string }
  | { type: "models-updated"; snapshot: RuntimeSnapshot; message: string }
  | { type: "selected"; modelKey: string }
  | { type: "failed"; message: string };

export function initialTuiState(selectedModel?: string): TuiState {
  return {
    phase: "starting",
    snapshot: null,
    selectedModel: selectedModel ?? null,
    operation: "refresh",
    message: "Connecting to LM Studio…",
  };
}

export function reduceTuiState(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case "refresh-started":
      return { ...state, phase: "busy", operation: "refresh", message: "Refreshing…" };
    case "refresh-succeeded":
      return {
        ...state,
        phase: "ready",
        snapshot: event.snapshot,
        selectedModel: chooseSelection(event.snapshot, state.selectedModel),
        operation: null,
        message: event.snapshot.route
          ? `${event.snapshot.models.filter((model) => model.type === "llm").length} LLM(s) available`
          : "LM Studio is offline",
      };
    case "operation-started":
      return {
        ...state,
        phase: "busy",
        operation: event.operation,
        message: event.message,
      };
    case "models-updated":
      return {
        ...state,
        phase: "ready",
        snapshot: event.snapshot,
        selectedModel: chooseSelection(event.snapshot, state.selectedModel),
        operation: null,
        message: event.message,
      };
    case "selected":
      return { ...state, selectedModel: event.modelKey };
    case "failed":
      return { ...state, phase: "error", operation: null, message: event.message };
  }
}

function chooseSelection(snapshot: RuntimeSnapshot, preferred: string | null): string | null {
  const models = snapshot.models.filter((model) => model.type === "llm");
  if (preferred && models.some((model) => model.key === preferred)) {
    return preferred;
  }
  return models[0]?.key ?? null;
}
