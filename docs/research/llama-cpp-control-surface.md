# llama.cpp control surface for LocalHub v1

Research date: 2026-07-25

## Question

Against current official llama.cpp documentation and source on Apple Silicon,
which controls, APIs, and metadata can LocalHub rely on for exact Run Profiles,
model inspection, serving, and lifecycle management?

## Decision-ready recommendation

LocalHub v1 should supervise a pinned `llama-server` worker for each loaded Run
Profile and keep its own LAN gateway, Request Queue, model catalog, and lifecycle
state. The worker should listen on loopback only. LocalHub should not expose the
llama.cpp router or built-in Web UI/tools directly to Members.

An exact Run Profile should:

1. Identify the pinned llama.cpp build, Model Variant file and hash, optional
   multimodal projector and hash, and chat template.
2. Render every meaningful load-time choice to explicit command-line arguments.
   In particular, never use `0`, `auto`, or `-1` where those values ask
   llama.cpp to choose; pass `--fit off` so the runtime cannot resize unset
   context or placement controls to fit available memory. The released server
   defaults `--fit` to on and `--n-gpu-layers` to auto. [The generated option
   reference documents both behaviors.][server-load-options]
3. Store **context per slot**, **slot count**, and **KV layout** separately. With
   non-unified KV, render total `--ctx-size` as
   `context_per_slot * parallel`; with unified KV, llama.cpp reports total
   context as the per-sequence maximum and the slots dynamically share that
   capacity. Require `/props` and `/slots` to report the requested per-slot
   value before a Profile Test passes. The official non-unified multi-user
   example gives four 4,096-token slots by launching with `-c 16384 -np 4`.
   [Official server example.][parallel-example]
   [Released context-layout source.][context-layout]
4. Treat all load-time changes as a worker restart. `/props` is useful for
   observation, but the released POST endpoint has no mutable properties.
   [The endpoint explicitly says “None yet.”][props]
5. Pass only an allowlist of Member-adjustable request fields, such as sampling
   and output-token limits. Host-only memory, placement, context capacity,
   parallelism, templates, and multimodal configuration stay fixed for the
   worker lifetime.
6. Fail a Profile Test if the worker exits, `/health` does not become ready, the
   observed context or model identity differs, or a required capability cannot
   complete a small real request. Recommendations may come from
   `llama-fit-params`, but the Host must explicitly accept its proposed
   arguments before they become a Run Profile. [The utility prints the exact
   adjustments it proposes.][fit-params]

This gives the Host precise controls without promising that an untested setting
will fit, perform well, or preserve model quality.

## Meaning of “stable” in this report

The inspected release is **b10107**, published 2026-07-24 at commit
`c0bc8591e8815c63cb01dd3f051a8b0df02501c9`. It includes a macOS arm64 archive
with a published SHA-256 digest. [Official release and assets.][release]

llama.cpp uses frequent build-number releases; the primary sources inspected do
not promise semantic-version or cross-release API stability. “Released” below
therefore means present, documented, and not marked experimental in b10107—not a
promise that a later build will preserve names or behavior. LocalHub must pin a
tested build and rerun its acceptance suite before offering an update.

## Released controls LocalHub can use

### Model Variant discovery and inspection

- A GGUF file is the Model Variant. Weight quantization is a property of that
  file, not a setting that can be changed after loading. The GGUF specification
  defines model identity, architecture, size label, majority tensor file type,
  quantization version, training context, and RoPE scaling metadata. It also
  warns that the human-friendly filename convention is not perfectly parsable.
  LocalHub should inspect the header rather than infer a quant from the
  filename. [GGUF identification and naming.][gguf-naming]
  [GGUF quantization metadata.][gguf-general]
  [GGUF context metadata.][gguf-context]
- llama.cpp ships an official `gguf_dump.py` reader that can emit metadata and
  tensor information as JSON without starting inference. That is an adequate
  reference for LocalHub's catalog reader or a pinned offline inspection
  helper. [Official dump implementation.][gguf-dump]
- `GET /models` in router mode discovers cached, directory, and preset entries,
  and exposes source, state, rendered arguments, and detected input modalities.
  It is useful supporting evidence, but it is not sufficient as LocalHub's
  catalog: released source has a TODO for additional unloaded-model fields and
  only merges full model information after the worker is running.
  [Router listing documentation.][router-list]
  [Released serializer source.][router-list-source]
- `GET /v1/models` on a loaded worker reports effective slot context,
  training context, parameter count, byte size, and file type. This is runtime
  verification, not offline discovery. [Loaded model metadata.][loaded-model]
- `llama-quantize` creates a new GGUF from a higher-precision GGUF and may lose
  quality. It is an offline conversion workflow, not Run Profile tuning.
  LocalHub v1 can select/download existing variants without offering local
  quant creation. [Official quantize workflow.][quantize]
- For exact downloads, LocalHub should require an explicit file or exact
  repository quant. The shorthand `-hf` defaults to Q4_K_M and falls back to
  the first file when that quant is absent, which conflicts with the no-silent-
  changes rule. [`-hf` and `--hf-file` behavior.][download-options]

### Context, KV cache, batching, and concurrency

The released CLI exposes these suitable Host controls:

- Context: `--ctx-size`; RoPE scaling method/factor/base; YaRN original context
  and factors. The model's training context is separately observable as
  `n_ctx_train`. [Context and RoPE arguments.][context-options]
- KV behavior: `--cache-type-k`, `--cache-type-v`, `--kv-offload`,
  `--kv-unified`, prompt caching/reuse, cache RAM, idle-slot caching, and
  context shift. [KV types and offload.][kv-options]
  [Server cache controls.][server-cache-options]
- Work sizing: generation and batch thread counts, logical `--batch-size`,
  physical `--ubatch-size`, explicit `--parallel`, and continuous batching.
  [Batch arguments.][batch-options]
  [Parallel server arguments.][parallel-options]
- Per-request sampling: temperature, top-k/top-p/min-p, penalties, DRY,
  Mirostat, seed, stop strings, grammar/JSON schema, sampler order, and output
  limit. The non-OAI `/completion` response reports generation settings but
  warns that they may differ after filtering or conversion; LocalHub should
  validate and report the effective values rather than claim byte-for-byte
  identity. [Sampling arguments.][sampling-options]
  [Effective-settings warning.][effective-settings]

Important exactness constraints:

- The released server changes an automatic parallel value to four slots and a
  unified KV cache. A profile must therefore pass an explicit positive
  `--parallel` and explicit KV choice. [Released normalization source.][server-normalization]
- Released server source caps computed per-slot context to the model's reported
  training context and logs a warning. A Profile Test requesting more than
  `n_ctx_train` must fail unless the observed `/props` value exactly matches;
  the dashboard must not treat a requested RoPE extension as proof it took
  effect. [Released context-cap source.][context-cap]
- Quantized KV types are valid controls, but official function-calling guidance
  warns that extreme KV quantization can substantially hurt tool-calling
  quality. This belongs in Profile Test results, not just memory estimates.
  [Official warning.][tool-kv-warning]

### Compute and tensor placement on Apple Silicon

- Metal is enabled by default in a macOS build; `--n-gpu-layers 0` explicitly
  disables GPU inference. [Official Metal build documentation.][metal-build]
- Released placement controls include device selection/listing, an exact number
  of GPU-offloaded layers, CPU placement for MoE layers, tensor-to-buffer
  overrides, operation offload, KV offload, and Flash Attention on/off.
  [Placement arguments.][placement-options]
- Apple Silicon uses unified memory shared by CPU and GPU, so LocalHub should
  label this as **GPU-offloaded layers / placement**, not dedicated VRAM.
  Apple's Metal API exposes whether a device has unified memory and an
  approximate recommended maximum working set, but neither proves that a
  particular profile will fit. [Apple Metal memory model.][apple-memory]
- Multi-device `layer` and `row` split modes are released controls, but are not
  useful defaults for the single-GPU Apple Silicon v1 target. Keep them in an
  expert escape hatch only after the actual device inventory is shown.

### Templates, tools, and multimodal capability

- Chat template and Jinja selection are load-time controls. `/props` exposes
  the template and its declared capabilities. Function calling depends on a
  suitable model/template combination; generic fallback exists but can be less
  efficient, and the official guide uses model-specific overrides for some
  models. LocalHub must test tool-call behavior per Model Variant and profile.
  [Function-calling support and caveats.][function-calling]
- The OpenAI-style chat endpoint accepts typed image, audio, and video parts
  when the model and multimodal projector support them. `/props` exposes
  modalities; router model metadata also exposes input modalities.
  [Multimodal request shapes.][multimodal-api]
- llama.cpp does not accept arbitrary PDF, Word, or other document semantics as
  a model capability. LocalHub must parse a deliberately uploaded document
  itself, submit extracted text (and supported images if appropriate), and
  delete its temporary copy under LocalHub's attachment policy.
- Browser Tools such as Web Search must remain LocalHub-owned tool calls. The
  llama.cpp `/tools` surface is explicitly internal and subject to removal;
  its built-in file and shell tools must not be enabled for a LAN-facing worker.
  [Downstream-use prohibition.][builtin-tools]

### Health, observation, cancellation, and lifecycle

- `GET /health` distinguishes loading (503) from ready (200).
  [Health contract.][health]
- Read-only `GET /props` reports effective per-slot context, slot count, model
  path, template/capabilities, modalities, build info, and sleep state.
  [Properties contract.][props]
- `GET /slots` reports whether each slot is processing, its effective context,
  sampling settings, and progress-related state. `GET /metrics`, when enabled,
  reports token rates and counts plus processing/deferred request counts. These
  are useful inputs to the Host dashboard, but LocalHub's visible fair queue
  must remain its own source of truth. [Slots contract.][slots]
  [Metrics contract.][metrics]
- Ordinary streaming generation is tied to its HTTP connection; dropping that
  connection aborts generation. The released server also has an opt-in
  resumable stream keyed by `X-Conversation-Id` with an idempotent DELETE route,
  documented in the developer README. LocalHub v1 can cancel by closing its
  upstream request; the resumable route should be adopted only after a live
  compatibility test. [`llama-server` stream cancellation behavior.][stream-cancel]
- `/v1/chat/completions/control` is **not** a general cancel endpoint; its only
  released action ends a reasoning block. [Control endpoint.][reasoning-control]
- `llama-server` installs SIGINT/SIGTERM handlers and runs cleanup before exit.
  A LocalHub supervisor can request a graceful stop, wait a bounded time, then
  report/force termination. [Released signal and cleanup source.][process-lifecycle]

### OpenAI-compatible serving

The released server documents `/v1/models`, `/v1/completions`,
`/v1/chat/completions`, `/v1/responses`, and embedding routes. Streaming and
tool-call parsing are present. However, the official documentation explicitly
declines to make strong OpenAI compatibility claims for completions/chat.
[Compatibility caveat.][oai-compat]

Therefore:

- Browser Chat may use a narrow, LocalHub-tested subset of chat completions.
- Codex support must be an acceptance-tested adapter against the pinned Codex
  and llama.cpp builds. Endpoint names alone are not proof that Responses API,
  streaming events, tool calls, usage, errors, and cancellation match what
  Codex expects.
- LocalHub should proxy and normalize the external API instead of making the
  raw worker a permanent public contract.

## Released router surface: useful, but not the v1 control plane

The released router can discover sources, read INI presets, load/unload named
models, publish status/SSE progress, download an exact named Hugging Face model,
and delete cached models. Presets accept normal llama.cpp arguments; command
line values override per-model values, which override global values.
[Router and presets.][router-presets]
[Load/unload API.][router-lifecycle]
[Download API.][router-download]

This is real released functionality, not marked experimental. It should still
remain behind LocalHub for v1 because:

- autoload is enabled by default and the router owns LRU unloading when its
  model limit is reached; [Released LRU source.][router-lru]
- refreshing sources can unload a running model that changed or disappeared;
- `POST /models/load` names a preconfigured model but does not accept an exact
  Run Profile payload;
- LocalHub already needs to own fairness, pinning, active-request protection,
  Member-visible queue position, and Profile Test records.

LocalHub may internally adopt the router later if live tests show that disabled
autoload plus generated presets preserve those invariants. That is an
implementation choice, not part of the external LocalHub contract.

## Experimental or unsafe as a v1 dependency

- **Multimodal server input:** officially documented but explicitly marked
  experimental. Ship only behind a capability flag and a tested model/projector
  allowlist; never infer support from the model name. [Experimental label.][multimodal-experimental]
- **Tensor split mode:** the `tensor` multi-GPU split is explicitly
  experimental. [Split-mode label.][placement-options]
- **Backend sampling:** explicitly experimental. Keep normal sampling in v1.
  [Backend-sampling label.][sampling-options]
- **Built-in agent tools and MCP proxy:** explicitly experimental, unsafe in
  untrusted environments, and the REST API is forbidden for downstream use.
  Do not enable them. [Built-in tool flags.][tool-flags]
- **Automatic fitting:** released, but incompatible with an exact profile when
  used during Test/Start. It is safe only as a recommendation generator whose
  output the Host reviews and saves. [Automatic fitter.][fit-params]
- **Context extension, aggressive KV quantization, custom tensor overrides,
  speculative decoding, and custom templates:** documented controls, but their
  fit, speed, and quality are model/hardware dependent. Keep them in Advanced
  mode and require a Profile Test.

## Unavailable or insufficient in the released surface

- No live API mutates context, batch sizes, KV types, tensor placement, or
  parallel slots; worker restart is required.
- No general public REST endpoint cancels an arbitrary request/task ID.
- No documented metrics endpoint exposes a complete per-worker breakdown of
  model, KV, compute, and peak unified-memory consumption. Use llama.cpp's
  projections only as estimates and measure the real process/system during a
  Profile Test.
- No unloaded-model router response guarantees complete quantization, tensor,
  context, template, or parameter metadata. Read GGUF directly.
- No generic “document upload” inference API. Extraction is LocalHub work.
- No API proves tool-call correctness, multimodal quality, or full Codex
  compatibility. Those are acceptance tests.
- No upstream scheduling API implements LocalHub's cross-model fair queue,
  Member positions, pinning policy, or starvation prevention.

## Facts that require live Apple Silicon proof

Before a setting/model combination can be marked Tested, LocalHub must record:

1. Pinned llama.cpp version/build and binary digest; macOS version, chip, memory,
   and `--list-devices` output.
2. Model/mmproj hashes and parsed GGUF metadata.
3. Exact rendered command, with automatic values rejected and `--fit off`.
4. Clean load, `/health` readiness, `/v1/models` identity, `/props` build,
   modalities/template, and exact per-slot context/slot count.
5. Backend/offload evidence from startup logs plus actual peak memory and system
   headroom. Apple unified memory makes a generic “VRAM estimate” inadequate.
6. Prompt-processing and generation throughput, time to first token, and a
   context-boundary request. `llama-bench` supports JSON output and sweeps for
   batches, threads, cache types, and GPU layers, but explicitly excludes
   tokenization and sampling time; Browser Chat still needs an end-to-end test.
   [Official benchmark scope.][bench]
7. Concurrent requests at the chosen slot count, LocalHub queue position and
   cancellation, graceful worker stop, and model switch without interrupting an
   active response.
8. If enabled: image ingestion, document extraction, each Host-approved Browser
   Tool, structured tool-call round trips, and Codex Responses API/tool usage.

An estimate or successful process start is not a passing Profile Test.

## Source quality and limits

- Sources are first-party only: the exact ggml-org/llama.cpp release, its docs
  and source, the ggml-org GGUF specification, and Apple Metal documentation.
- Most option and endpoint claims come from the generated released server
  reference and are cross-checked against released source where exactness or
  lifecycle matters.
- No model was downloaded and no Apple Silicon runtime test was performed for
  this research ticket. Hardware behavior, resource use, model quality,
  cancellation, multimodal behavior, and Codex compatibility remain explicit
  live-proof gates.

[release]: https://github.com/ggml-org/llama.cpp/releases/tag/b10107
[server-load-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L50-L103
[parallel-example]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/README.md#L398-L404
[context-layout]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/src/llama-context.cpp#L283-L309
[props]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L764-L866
[fit-params]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/fit-params/README.md#L1-L29
[gguf-naming]: https://github.com/ggml-org/ggml/blob/9be313313c8ecb9488911bd64550190e3ed80f38/docs/gguf.md#L13-L32
[gguf-general]: https://github.com/ggml-org/ggml/blob/9be313313c8ecb9488911bd64550190e3ed80f38/docs/gguf.md#L369-L451
[gguf-context]: https://github.com/ggml-org/ggml/blob/9be313313c8ecb9488911bd64550190e3ed80f38/docs/gguf.md#L447-L485
[gguf-dump]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/gguf-py/gguf/scripts/gguf_dump.py#L32-L99
[router-list]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1724-L1807
[router-list-source]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-models.cpp#L1644-L1715
[loaded-model]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1173-L1205
[quantize]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/quantize/README.md#L1-L67
[download-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L100-L107
[context-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L50-L67
[kv-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L68-L78
[server-cache-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L164-L220
[batch-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L38-L53
[parallel-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L168-L182
[sampling-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L120-L157
[effective-settings]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L593-L607
[server-normalization]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server.cpp#L140-L151
[context-cap]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-context.cpp#L1244-L1275
[tool-kv-warning]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/docs/function-calling.md#L327-L335
[metal-build]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/docs/build.md#L133-L138
[placement-options]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L80-L94
[apple-memory]: https://developer.apple.com/documentation/metal/mtldevice/hasunifiedmemory
[function-calling]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/docs/function-calling.md#L1-L24
[multimodal-api]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1238-L1271
[builtin-tools]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1570-L1575
[health]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L402-L415
[slots]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L908-L977
[metrics]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1056-L1076
[stream-cancel]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README-dev.md#L121-L149
[reasoning-control]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1373-L1387
[process-lifecycle]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server.cpp#L376-L460
[oai-compat]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1173-L1244
[router-presets]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1577-L1696
[router-lifecycle]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1809-L1851
[router-download]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1924-L1978
[router-lru]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-models.cpp#L745-L771
[multimodal-experimental]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L323-L331
[tool-flags]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L198-L203
[bench]: https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/llama-bench/README.md#L20-L99
