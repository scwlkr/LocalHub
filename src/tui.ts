import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  type SelectOption,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import { saveSelectedModel } from "./config.ts";
import {
  modelOption,
  renderModelDetails,
  renderTuiDiagnostics,
  renderTuiSummary,
} from "./presentation.ts";
import { collectRuntime, ensureModelLoaded, type RuntimeContext, unloadModel } from "./runtime.ts";
import { initialTuiState, reduceTuiState, type TuiEvent, type TuiState } from "./state.ts";
import type { LocalHubConfig, ModelInfo } from "./types.ts";

export type TuiResult =
  | { kind: "quit" }
  | {
      kind: "launch";
      codexPath: string;
      modelId: string;
      endpoint: string;
      token?: string;
    };

export interface TuiLayout {
  stateBox: BoxRenderable;
  summary: TextRenderable;
  modelsBox: BoxRenderable;
  models: SelectRenderable;
  detailsBox: ScrollBoxRenderable;
  details: TextRenderable;
  footer: TextRenderable;
  modelOptionsSignature: string;
}

export interface TuiDependencies {
  createRenderer?: typeof createCliRenderer;
  collect?: typeof collectRuntime;
  env?: NodeJS.ProcessEnv;
  ensureLoaded?: typeof ensureModelLoaded;
  unload?: typeof unloadModel;
  saveSelection?: typeof saveSelectedModel;
}

export function createTuiLayout(renderer: CliRenderer): TuiLayout {
  const root = new BoxRenderable(renderer, {
    id: "layout",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    gap: 0,
    padding: 1,
  });
  const header = new TextRenderable(renderer, {
    id: "header",
    height: 1,
    content: "LocalHub · local LM Studio → local Codex tools",
    fg: "#7dd3fc",
  });
  const stateBox = new BoxRenderable(renderer, {
    id: "state-box",
    title: " State ",
    border: true,
    borderColor: "#475569",
    height: 7,
    paddingX: 1,
  });
  const summary = new TextRenderable(renderer, {
    id: "summary",
    width: "100%",
    height: "100%",
    content: "Connecting…",
  });
  const modelsBox = new BoxRenderable(renderer, {
    id: "models-box",
    title: " Installed LLMs ",
    border: true,
    borderColor: "#475569",
    flexGrow: 1,
    minHeight: 4,
    paddingX: 1,
  });
  const models = new SelectRenderable(renderer, {
    id: "models",
    width: "100%",
    height: "100%",
    options: [],
    wrapSelection: true,
    showDescription: true,
    showScrollIndicator: true,
    selectedBackgroundColor: "#164e63",
    selectedTextColor: "#ffffff",
    selectedDescriptionColor: "#bae6fd",
  });
  const detailsBox = new ScrollBoxRenderable(renderer, {
    id: "details-box",
    title: " Selection ",
    border: true,
    borderColor: "#475569",
    height: 9,
    paddingX: 1,
    scrollX: false,
    scrollY: true,
  });
  const details = new TextRenderable(renderer, {
    id: "details",
    width: "100%",
    height: "auto",
    content: "No LLM selected.",
  });
  const footer = new TextRenderable(renderer, {
    id: "footer",
    height: 2,
    content:
      "↑/↓ select · Enter/c launch · l load/reload · u unload · r refresh · d diagnostics · q quit",
    fg: "#94a3b8",
  });

  stateBox.add(summary);
  modelsBox.add(models);
  detailsBox.add(details);
  root.add(header);
  root.add(stateBox);
  root.add(modelsBox);
  root.add(detailsBox);
  root.add(footer);
  renderer.root.add(root);
  models.focus();

  const layout = {
    stateBox,
    summary,
    modelsBox,
    models,
    detailsBox,
    details,
    footer,
    modelOptionsSignature: "",
  };
  resizeTuiLayout(layout, renderer.height);
  renderer.on("resize", (_width: number, height: number) => {
    resizeTuiLayout(layout, height);
  });
  return layout;
}

function resizeTuiLayout(layout: TuiLayout, terminalHeight: number): void {
  if (terminalHeight <= 18) {
    layout.stateBox.height = 4;
    layout.modelsBox.minHeight = 3;
    layout.detailsBox.height = 5;
    return;
  }
  if (terminalHeight <= 22) {
    layout.stateBox.height = 5;
    layout.modelsBox.minHeight = 3;
    layout.detailsBox.height = 7;
    return;
  }
  layout.stateBox.height = 7;
  layout.modelsBox.minHeight = 4;
  layout.detailsBox.height = 9;
}

export function updateTuiLayout(
  layout: TuiLayout,
  state: TuiState,
  config: LocalHubConfig,
  showDiagnostics: boolean,
): void {
  layout.summary.content = renderTuiSummary(state.snapshot, config);
  const llms = state.snapshot?.models.filter((model) => model.type === "llm") ?? [];
  const options = llms.map(modelOption);
  const optionsSignature = JSON.stringify(options);
  if (optionsSignature !== layout.modelOptionsSignature) {
    layout.models.options = options;
    layout.modelOptionsSignature = optionsSignature;
  }
  const selectedIndex = llms.findIndex((model) => model.key === state.selectedModel);
  if (selectedIndex >= 0 && layout.models.getSelectedIndex() !== selectedIndex) {
    layout.models.setSelectedIndex(selectedIndex);
  }
  const selected = llms.find((model) => model.key === state.selectedModel) ?? null;
  const diagnosticConfig = state.selectedModel
    ? { ...config, selectedModel: state.selectedModel }
    : config;
  layout.details.content =
    showDiagnostics && state.snapshot
      ? renderTuiDiagnostics(state.snapshot, diagnosticConfig)
      : renderModelDetails(selected);
  layout.detailsBox.title = showDiagnostics ? " Diagnostics " : " Selection ";
  layout.detailsBox.verticalScrollBar.visible = showDiagnostics;
  layout.detailsBox.scrollTo(0);
  if (showDiagnostics) {
    layout.detailsBox.focus();
  } else {
    layout.models.focus();
  }
  const busy = state.phase === "busy" ? " [busy · q cancels]" : "";
  layout.footer.content = [
    `${state.message}${busy}`,
    showDiagnostics
      ? "↑↓/jk scroll · d close · l load · u unload · r refresh · q quit"
      : "↑↓/jk · Enter/c launch · l load · u unload · r refresh · d diag · q quit",
  ].join("\n");
}

export async function runTui(
  config: LocalHubConfig,
  configFile: string,
  dependencies: TuiDependencies = {},
): Promise<TuiResult> {
  const createRenderer = dependencies.createRenderer ?? createCliRenderer;
  const collect = dependencies.collect ?? collectRuntime;
  const ensureLoaded = dependencies.ensureLoaded ?? ensureModelLoaded;
  const unloadSelected = dependencies.unload ?? unloadModel;
  const saveSelection = dependencies.saveSelection ?? saveSelectedModel;
  const env = dependencies.env ?? process.env;
  const renderer = await createRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    clearOnShutdown: true,
    consoleMode: "disabled",
    openConsoleOnError: false,
    useMouse: false,
  });
  const layout = createTuiLayout(renderer);
  let state = initialTuiState(config.selectedModel);
  let runtime: RuntimeContext | null = null;
  let showDiagnostics = false;
  let settled = false;
  let stopping = false;
  let activeController: AbortController | null = null;

  const dispatch = (event: TuiEvent): void => {
    state = reduceTuiState(state, event);
    updateTuiLayout(layout, state, config, showDiagnostics);
  };

  const selectedModel = (): ModelInfo | null =>
    state.snapshot?.models.find(
      (model) => model.type === "llm" && model.key === state.selectedModel,
    ) ?? null;

  const refresh = async (): Promise<void> => {
    if (state.phase === "busy" || stopping) {
      return;
    }
    dispatch({ type: "refresh-started" });
    const controller = new AbortController();
    activeController = controller;
    try {
      const collected = await collect(config, { env, signal: controller.signal });
      if (stopping || controller.signal.aborted) {
        return;
      }
      runtime = collected;
      dispatch({ type: "refresh-succeeded", snapshot: runtime.snapshot });
    } catch (error) {
      if (stopping || controller.signal.aborted) {
        return;
      }
      dispatch({ type: "failed", message: errorMessage(error) });
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  const load = async (): Promise<string | null> => {
    if (state.phase === "busy" || stopping) {
      return null;
    }
    const model = selectedModel();
    if (!model || !runtime?.client || !state.snapshot?.route) {
      dispatch({
        type: "failed",
        message: "No reachable LM Studio LLM. Start the server, refresh, and select a model.",
      });
      return null;
    }
    dispatch({
      type: "operation-started",
      operation: "load",
      message: `Loading ${model.displayName} at ${config.contextLength.toLocaleString("en-US")} tokens…`,
    });
    const controller = new AbortController();
    activeController = controller;
    try {
      const outcome = await ensureLoaded(
        runtime.client,
        model,
        config.contextLength,
        controller.signal,
      );
      if (stopping || controller.signal.aborted) {
        return null;
      }
      runtime.snapshot = { ...runtime.snapshot, models: outcome.models };
      let persistenceWarning = "";
      try {
        await saveSelection(model.key, config, configFile, controller.signal);
      } catch (error) {
        if (stopping || controller.signal.aborted) {
          return null;
        }
        persistenceWarning = ` Preference not saved: ${errorMessage(error)}.`;
      }
      if (stopping || controller.signal.aborted) {
        return null;
      }
      dispatch({
        type: "models-updated",
        snapshot: runtime.snapshot,
        message: `${outcome.reloaded ? "Reloaded" : "Loaded"} ${model.displayName} at ${config.contextLength.toLocaleString("en-US")} tokens.${persistenceWarning}`,
      });
      return outcome.instanceId;
    } catch (error) {
      if (stopping || controller.signal.aborted) {
        return null;
      }
      dispatch({ type: "failed", message: errorMessage(error) });
      return null;
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  const unload = async (): Promise<void> => {
    if (state.phase === "busy" || stopping) {
      return;
    }
    const model = selectedModel();
    if (!model || !runtime?.client || !state.snapshot?.route) {
      dispatch({ type: "failed", message: "No reachable selected LLM to unload." });
      return;
    }
    if (model.loadedInstances.length === 0) {
      dispatch({
        type: "models-updated",
        snapshot: runtime.snapshot,
        message: `${model.displayName} is already unloaded.`,
      });
      return;
    }
    dispatch({
      type: "operation-started",
      operation: "unload",
      message: `Unloading ${model.displayName}…`,
    });
    const controller = new AbortController();
    activeController = controller;
    try {
      const models = await unloadSelected(runtime.client, model, controller.signal);
      if (stopping || controller.signal.aborted) {
        return;
      }
      runtime.snapshot = {
        ...runtime.snapshot,
        models,
      };
      dispatch({
        type: "models-updated",
        snapshot: runtime.snapshot,
        message: `Unloaded ${model.displayName}.`,
      });
    } catch (error) {
      if (stopping || controller.signal.aborted) {
        return;
      }
      dispatch({ type: "failed", message: errorMessage(error) });
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  updateTuiLayout(layout, state, config, showDiagnostics);

  return await new Promise<TuiResult>((resolve) => {
    let pendingResult: TuiResult | null = null;

    const finish = (result: TuiResult): void => {
      if (settled || stopping) {
        return;
      }
      stopping = true;
      pendingResult = result;
      activeController?.abort();
      if (!renderer.isDestroyed) {
        renderer.destroy();
      } else {
        settled = true;
        resolve(result);
      }
    };

    const launch = async (): Promise<void> => {
      const model = selectedModel();
      const route = runtime?.snapshot.route;
      const codexPath = runtime?.snapshot.codexPath;
      if (!model || !route) {
        dispatch({
          type: "failed",
          message: "No reachable LM Studio LLM. Start the server, refresh, and select a model.",
        });
        return;
      }
      if (!codexPath) {
        dispatch({
          type: "failed",
          message: "Codex is missing. Install it and confirm `codex --version` works.",
        });
        return;
      }
      const instanceId = await load();
      if (!instanceId) {
        return;
      }
      const token = route.auth === "accepted" ? env[config.tokenEnv] : undefined;
      finish({
        kind: "launch",
        codexPath,
        modelId: instanceId,
        endpoint: route.endpoint,
        ...(token ? { token } : {}),
      });
    };

    layout.models.on(
      SelectRenderableEvents.SELECTION_CHANGED,
      (_index: number, option: SelectOption | null) => {
        if (option?.value) {
          dispatch({ type: "selected", modelKey: String(option.value) });
        }
      },
    );
    layout.models.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      void launch();
    });
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish({ kind: "quit" });
        return;
      }
      if (key.name === "r") {
        void refresh();
      } else if (key.name === "l") {
        void load();
      } else if (key.name === "u") {
        void unload();
      } else if (key.name === "d") {
        showDiagnostics = !showDiagnostics;
        updateTuiLayout(layout, state, config, showDiagnostics);
      } else if (key.name === "c") {
        void launch();
      }
    });
    renderer.once("destroy", () => {
      if (!settled) {
        settled = true;
        stopping = true;
        activeController?.abort();
        resolve(pendingResult ?? { kind: "quit" });
      }
    });

    state = { ...state, phase: "ready", operation: null };
    void refresh();
  }).finally(() => {
    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
