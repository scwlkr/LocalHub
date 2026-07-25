# Codex Tool Runner Client Contract

Research date: 2026-07-25  
Baselines: [Codex CLI 0.145.0](https://github.com/openai/codex/releases/tag/rust-v0.145.0) and [llama.cpp b10107](https://github.com/ggml-org/llama.cpp/releases/tag/b10107)

## Decision

LocalHub should provide a thin `lh codex` launcher on each Member Mac or Windows computer. The launcher starts a **local Codex CLI process** in a caller-selected local directory and points only that process at the Host's inference URL. The Host runs `llama-server` as an inference service; it does not run Codex, an app server, a shell tool, or a file tool for the Member.

This is feasible, with an important release gate: current Codex requires the Responses wire API, and llama.cpp's Responses implementation is new, conversion-based, and not officially tested end-to-end against Codex. LocalHub must pin both versions and pass the compatibility suite below before labeling a Model Run Profile “Codex capable.”

Do **not** use Codex remote app-server mode for this journey. `codex --remote` moves the TUI onto another Codex app-server; LocalHub needs a local Codex agent with only its model transport pointed at the Host. The CLI instead provides `--cd`, `--model`, and one-run `--config` overrides for this shape. [Codex CLI options](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

## Boundary

```text
Member computer                                Host computer

local terminal
  -> local `lh codex`
      -> local Codex process
          -> local sandbox + approvals
          -> local file/shell child processes
          -> HTTP/SSE POST /v1/responses ------> LocalHub gateway
                                                   -> queue
                                                   -> llama-server inference
```

The separation is structural in Codex. Responses output items become tool calls in the local tool router, the local shell handler applies the selected cwd/sandbox/approval policy, and the local executor spawns the child process with that cwd and environment. [tool-call routing](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/tools/router.rs#L111-L158), [local shell handling](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/tools/handlers/shell.rs#L63-L120), [local process spawn](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/exec.rs#L904-L957)

Therefore:

- `-C` / `--cd` must be a path on the Member computer. Codex treats it as the agent's working root. [Codex CLI options](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- Local sandbox and approval settings remain authoritative. A remote model cannot grant itself broader local access. [Codex sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security#sandbox-and-approvals)
- Prompts, tool schemas, selected file contents, and tool results still pass through Host inference. “Tools execute locally” does not mean the Host cannot see the text being inferred.
- LocalHub must never start llama.cpp with `--tools` or `--agent`. Those separate llama-server features execute against the **Host** filesystem and shell; they are disabled by default and are unnecessary for Codex function calling. [llama-server options](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L190-L207), [built-in tools](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L333-L337)

## Required launch contract

The launcher must construct an argv array and spawn Codex directly; it must not build a shell command string. Values below are process-scoped and must not be written to `~/.codex/config.toml`, `auth.json`, or a repository `.codex/config.toml`.

```text
codex
  --strict-config
  --model <Host model alias>
  --cd <absolute local Member path>
  --config model_provider="localhub"
  --config model_providers.localhub.name="LocalHub"
  --config model_providers.localhub.base_url="http://<Host address>:<port>/v1"
  --config model_providers.localhub.wire_api="responses"
  --config model_providers.localhub.requires_openai_auth=false
  --config model_providers.localhub.supports_websockets=false
  --config model_context_window=<exact active Host context>
  --config model_supports_reasoning_summaries=false
  --config service_tier="default"
  --config features.fast_mode=false
  --config web_search="disabled"
  --config shell_environment_policy.ignore_default_excludes=false
```

Why each part is required:

- CLI overrides have highest configuration precedence and dotted keys can set nested values for one invocation. Provider configuration is intentionally ignored in repository `.codex/config.toml`, so a checked-in project file cannot safely implement this handoff. [Codex configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence), [one-off overrides and project restrictions](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli)
- `localhub` must be a distinct custom provider ID. Built-in IDs including `openai`, `ollama`, and `lmstudio` are reserved. A custom provider with `requires_openai_auth=false` skips OpenAI login, while an omitted `env_key` means no provider secret is required. [custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers), [Codex provider definition](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/model-provider-info/src/lib.rs#L86-L140)
- Current Codex has only `responses` as a valid wire API and explicitly rejects `wire_api="chat"`. The general model documentation still describes Chat Completions as deprecated, but the current released client source is stricter; LocalHub must follow the released client. [Codex 0.145.0 wire API](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/model-provider-info/src/lib.rs#L50-L83)
- `supports_websockets=false` forces the HTTP/SSE route llama-server implements.
- The exact context override is mandatory. An unknown model slug otherwise receives fallback metadata with a 272,000-token window, which may exceed the Host Run Profile and fail late. [Codex unknown-model fallback](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/models-manager/src/model_info.rs#L124-L167)
- Disabling reasoning summaries, fast service tier, and hosted web search removes OpenAI-specific behavior that the LocalHub route does not promise. Current Codex web search otherwise defaults to an OpenAI-maintained cache. [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- Keeping default shell secret exclusions enabled prevents inherited variables containing `KEY`, `SECRET`, or `TOKEN` from reaching model-requested child processes. Codex's raw default is to skip those exclusions, so LocalHub must set this explicitly. [shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy), [policy source](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/protocol/src/config_types.rs#L204-L240)

LocalHub's agreed LAN-only v1 has no Member login or PIN, so it should omit provider auth entirely. If a later decision adds a transport token, use a child-only environment variable named by `env_key`, keep the automatic secret exclusions above, and never put the token in argv, TOML, logs, diagnostics, issue comments, or history. Codex documents `experimental_bearer_token` as discouraged in favor of `env_key`. [provider auth fields](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/model-provider-info/src/lib.rs#L93-L106)

This contract leaves the user's ordinary Codex installation and login untouched. Plain `codex` after the child exits resolves the user's normal configuration again. It does not provide total isolation from user-installed MCP servers, plugins, hooks, or other global Codex customization; those remain local user choices. A future “strictly offline Codex” mode would need a separate `CODEX_HOME` policy and is not implied by this ticket. Codex stores config, auth, history, and other state below `CODEX_HOME`. [Codex config and state locations](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations)

## Responses compatibility

llama-server b10107 advertises an OpenAI-compatible `POST /v1/responses` endpoint and converts Responses requests into its Chat Completions implementation. [server capabilities](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1-L20), [Responses endpoint](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/README.md#L1389-L1429)

The current source covers the core Codex loop:

- Responses `function` tool definitions are converted to Chat Completions tools. [request conversion](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-chat.cpp#L250-L279)
- Prior `function_call` and `function_call_output` items are converted back into assistant tool calls and tool-result messages. [tool history conversion](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-chat.cpp#L163-L216)
- Both streaming and final responses emit `function_call` output items with `call_id`, `name`, and arguments, followed by `response.completed`. [function-call output](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-task.cpp#L592-L620), [stream completion](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-task.cpp#L692-L725)
- Codex consumes `response.output_item.done` as a typed response item and requires a terminal `response.completed` event. [Codex SSE parser](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/codex-api/src/sse/responses.rs#L327-L339), [completion handling](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/codex-api/src/sse/responses.rs#L434-L458)

Compatibility is not universal:

- llama.cpp skips every Responses tool type except `function`. Codex can represent `namespace`, `tool_search`, hosted `web_search`, and freeform/custom tools, so LocalHub cannot expose those through raw llama-server without a compatibility adapter. [llama.cpp skip behavior](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-chat.cpp#L252-L278), [Codex tool types](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/tools/src/tool_spec.rs#L13-L51)
- The unknown-model fallback does expose a function-based shell tool and disables parallel tool calls, but it does not expose Codex's dedicated apply-patch tool. Shell-driven file editing remains possible. [fallback model metadata](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/models-manager/src/model_info.rs#L124-L167), [shell tool selection](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/tools/spec_plan.rs#L622-L660)
- llama.cpp rejects `previous_response_id`, skips non-function tools, and does not support Responses `input_file`. Codex's current request builder sends full input history rather than `previous_response_id`, so the first limitation is compatible today but must be regression-tested on upgrades. [llama.cpp input conversion](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-chat.cpp#L6-L12), [file limitation](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/server-chat.cpp#L79-L96), [Codex request builder](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/core/src/client.rs#L825-L908)
- Protocol support does not guarantee that a model will reliably choose a tool or produce valid arguments. llama.cpp requires a usable Jinja chat template, has native handlers for some model families, and falls back to a less efficient generic format for others. [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/docs/function-calling.md#L1-L24)

## Windows contract

Support two explicit modes, never an accidental mixture:

1. **Native Windows:** Windows Codex, PowerShell, Windows paths, and the native Windows sandbox. Elevated sandbox setup is recommended; unelevated is the fallback when administrator setup is unavailable.
2. **WSL2:** Linux Codex and `lh` run inside the same WSL2 distribution using Linux paths and Linux sandboxing. WSL1 is unsupported starting with Codex 0.115.

The official Windows guidance says the native agent runs commands in PowerShell, WSL2 uses Linux sandboxing, and repositories should live in the filesystem matching the active agent for reliability. [Codex Windows](https://learn.chatgpt.com/docs/windows/windows-app#windows-subsystem-for-linux-wsl), [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)

Windows-specific limitations and gates:

- Native Windows does not enable Codex's unified PTY exec tool by default; function-based legacy shell execution remains the expected path. [Codex feature defaults](https://learn.chatgpt.com/docs/config-file/config-advanced#common-feature-flags)
- Elevated sandbox setup may need administrator permission. LocalHub must preserve the user's sandbox and approval choice; it must not compensate with full access.
- The launcher must pass argv directly with Windows-safe paths and TOML values; copying a POSIX shell command is not acceptable.
- Host discovery through `localhub.local` from both native Windows and WSL2 is not established by the official sources. The Host IP fallback is an acceptance requirement.

## Required acceptance suite

These are release gates, not optional follow-up polish:

1. Pin the tested Codex and llama.cpp versions; rerun the suite before either update is offered.
2. Against a deterministic fake Responses server, make Codex request one file/shell function, execute it in a temporary **Member** workspace, return the tool result, and complete the second model turn.
3. Assert the marker file exists only in the Member workspace and that the Host workspace is unchanged. Repeat with a denied path outside the Member sandbox.
4. Compare the user's `~/.codex/config.toml` and auth state before and after; they must be byte-identical. Run plain `codex doctor` afterward to prove the normal provider/login remains selected.
5. Capture the actual request and SSE event shapes. Fail on Chat Completions use, WebSocket use, missing `call_id`, missing `response.completed`, or unsupported non-function tools.
6. Run the same loop through the pinned llama-server with each proposed Codex-capable model/template. Test valid tool choice, malformed arguments, tool-result continuation, cancellation, context exhaustion, and several sequential calls.
7. Hold a queued Codex request longer than the normal queue target and prove the gateway keeps the client alive or returns an explicit retryable queue response. Current sources do not establish this behavior.
8. Run native macOS, native Windows PowerShell with both sandbox levels, and WSL2. Verify local cwd, path quoting, sandbox denial, Host IP fallback, interruption, and process cleanup.
9. Inspect the Host process argv and prove `--tools`, `--agent`, and an app-server listener are absent.

## Proof gaps

- No official OpenAI or ggml-org artifact claims Codex 0.145.0 end-to-end compatibility with llama-server b10107.
- llama.cpp's Responses unit tests cover basic streaming text, while function-call tests primarily exercise its Chat Completions path. The source mapping is sufficient to justify a prototype, not a production compatibility claim. [Responses tests](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/tests/unit/test_compat_oai_responses.py), [tool-call tests](https://github.com/ggml-org/llama.cpp/blob/c0bc8591e8815c63cb01dd3f051a8b0df02501c9/tools/server/tests/unit/test_tool_call.py)
- Raw llama-server cannot carry all Codex tool types. Initial v1 must limit the advertised Codex tool set to verified function tools, or LocalHub must add a Responses compatibility adapter.
- Queue keepalive, cancellation propagation, model unload during a Codex turn, mDNS behavior in Windows/WSL2, and version-skew error UX remain unproven.
- Model behavior is a separate gate from transport compliance. “Responses compatible” must not be displayed as “Codex capable” until the selected quant, template, context, and Run Profile pass the behavioral tool suite.

## Recommendation

Adopt this client contract for v1 planning. Build the compatibility harness before the Member launcher or dashboard promise, ship a pinned known-good pair, expose Host IP as well as `localhub.local`, and publish Codex only for Run Profiles that pass both protocol and real-model tool tests. Keep browser chat attachments and Host-managed search outside this raw Codex provider contract.
