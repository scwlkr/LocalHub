# LocalHub

LocalHub is a tiny open-source terminal UI, installed as `lh`, that connects
Codex to an LM Studio model without changing your normal Codex setup.

Run it from a project directory to inspect the machine, route, server, Codex,
memory, and installed models; select an LLM; load it with the requested minimum
context; then hand the terminal to Codex in that same directory. Inference can stay on a
64 GB Apple-silicon Mac while Codex and its tools run on either the Mac or a
Windows workstation.

## Behavior

- Discovers models from LM Studio at `GET /api/v1/models`; there is no
  hardcoded model catalog.
- Shows installed and loaded models, quantization, size, maximum and loaded
  context, format, and advertised vision, reasoning, and tool-use
  capabilities.
- Defaults to a 65,536-token context.
- Reuses an instance already loaded with at least that context. Otherwise it
  unloads the selected model's existing instances, loads it with
  `echo_load_config`, and verifies LM Studio provides at least the requested
  context. If the runtime expands the context, LocalHub reports the actual
  value while keeping Codex's context budget at the configured value.
- Tears down the alternate screen before starting Codex with inherited
  standard input/output/error. LocalHub returns Codex's exit code when Codex
  exits.
- Includes a Windows `lh setup` wizard for LM Link or authenticated direct
  LAN. Tokens are read with hidden input and remain process-scoped.
- Saves only non-secret preferences in the standard per-user configuration
  directory.

LocalHub does not download models and has no daemon, service, account,
telemetry, database, web UI, or hosted-provider manager.

## Requirements

- macOS arm64 or Windows x64
- Interactive terminal at least 80 columns by 18 rows
- [LM Studio](https://lmstudio.ai/) 0.4.15 or newer; LocalHub is live-tested
  with 0.4.20
- The current [Codex CLI](https://developers.openai.com/codex/cli), available
  as `codex` on `PATH`
- At least one LLM already installed in LM Studio
- A model whose maximum context is at least the configured context; native
  tool-use training is strongly preferred

LM Studio introduced its native v1 management API in 0.4.0. Version 0.4.15 is
recommended because its
  [release notes](https://lmstudio.ai/changelog/lmstudio-v0.4.15) include a fix
for a Codex tool-type error. Standalone LocalHub binaries do not require Bun;
the source installers require `bun`/`bunx` and invoke pinned Bun 1.3.14.

## Quick Start

From a checked-out LocalHub repository, install with one command.

macOS arm64:

```sh
./scripts/install.sh
```

This builds, ad hoc signs, smoke-tests, and installs
`~/.local/bin/lh`. If that directory is not already on `PATH`, the installer
prints the exact directory to add.

Windows x64, from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

This builds, smoke-tests, and installs
`%LOCALAPPDATA%\Programs\LocalHub\lh.exe`, then adds that directory to the
per-user `PATH` when needed. Open a new terminal if `lh` is not found
immediately.

### Mac validation target

The recommended initial validation target on a 64 GB Apple-silicon Mac is the
exact 29.1 GB MLX 6-bit build of Qwen3.6 35B-A3B. It is a documentation and
integration-test target, not a hardcoded LocalHub dependency:

```sh
lms get "https://huggingface.co/lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit" --mlx --yes
lms load --estimate-only qwen3.6-35b-a3b-mlx --gpu max --context-length 65536
lms load qwen3.6-35b-a3b-mlx --gpu max --context-length 65536 --parallel 1 \
  --identifier qwen/qwen3.6-35b-a3b --yes
lms server start --port 1234
lh doctor
lh
```

In `lh`, highlight `Qwen3.6 35B A3B`, confirm the selected variant is the
requested 6-bit MLX artifact, and press `l` to provide at least 65,536 tokens.
`Enter`/`c` loads when needed and launches Codex. The official LM Studio
recipe enables thinking and disables preserve-thinking by default; LocalHub
does not inject model-specific overrides.

> **Current MLX behavior (verified July 25, 2026):** LM Studio 0.4.20 with
> MLX runtime 1.10.1 accepts the 65,536 request but auto-fits this model to
> 258,816 tokens. LocalHub accepts the larger runtime, displays both values,
> and still tells Codex to budget for 65,536. This behavior is tracked by
> [LM Studio bug #2191](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2191).
> `/v1/responses`, stateful repeated function calls, and a real Codex
> read/create/edit/test loop pass with the expanded runtime.

### Windows path

The Windows installer now starts `lh setup` automatically after installation:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The wizard checks Codex and the local LM Studio API, then offers:

1. **LM Link:** runs the opted-in `lms` sign-in/link commands, lets you choose
   the Mac as Windows' preferred device, starts the Windows API server when
   needed, and verifies the visible model inventory.
2. **Direct LAN:** asks for the Mac origin and token, verifies anonymous access
   is rejected before sending the bearer token, lists the Mac's LLMs, checks
   the 65,536-token requirement, and saves only non-secret preferences.

The wizard can launch `lh` immediately. For later direct-LAN sessions, `lh`
asks for the token with hidden input only when the local/LM Link route cannot
serve the selected model. The token is not written to config, the user
environment, PowerShell profile, or registry.

Use `-SkipSetup` only for automation:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -SkipSetup
```

The source installers do not install or update Bun, LM Studio, Codex, models,
or firewall rules. The Windows installer starts the explicit setup wizard
unless `-SkipSetup` is supplied.

## LM Studio preparation

LocalHub manages already-installed models; it does not install LM Studio,
download model weights, or change the Mac's server security/firewall settings.
The Windows setup wizard can run LM Studio's documented link, preferred-device,
and local-server CLI commands after prompting.

On the inference Mac:

1. Install or update LM Studio and open it at least once.
2. Install the desired model in LM Studio.
3. Start the Developer server on port `1234`, either in the app or with
   `lms server start --port 1234`.
4. Confirm the model supports at least 65,536 tokens, or lower
   `contextLength`.

For Windows, choose either route:

- **LM Link:** sign in to LM Studio on both machines, link the Windows machine
  and Mac, set the 64 GB Mac as the preferred device on Windows, and start the
  Windows LM Studio server. Windows still talks to
  `http://127.0.0.1:1234`; LM Studio routes the model work to the preferred
  linked device. `lh setup` guides these steps. LM Link is optional.
- **Direct LAN fallback:** on the Mac, enable **Serve on Local Network**,
  require authentication, create an API token with model permissions, and
  allow the server port through the Mac firewall. Run `lh setup` on Windows;
  it stores the endpoint but keeps the entered token in memory only.

Direct LAN requires no LM Link dependency. Plain HTTP is not encrypted, so use
it only on a trusted LAN. See [SECURITY.md](SECURITY.md).

## Route selection

| Caller | Order | Authentication |
| --- | --- | --- |
| macOS | `localEndpoint` only | Anonymous first; retries with `tokenEnv` after an authentication response |
| Windows | `localEndpoint` first (local LM Studio or LM Link) | Anonymous first; retries with `tokenEnv` after an authentication response |
| Windows fallback | `lanEndpoint`, when local is unavailable or lacks the usable/preferred LLM | Token must be present; anonymous security probe must be rejected before the bearer request |

A successful model inventory request is the server-health check. LocalHub
reports authentication, DNS, firewall, host, HTTP, timeout, malformed-response,
and unsupported-context failures with a focused fix.

For direct LAN, LocalHub requires a process-scoped token from hidden input or
the configured environment variable. It first verifies that an anonymous
request receives `401` or `403`, and only then sends the bearer token. If the
server accepts the anonymous probe, LocalHub refuses the route and tells you
to enable **Require Authentication**.

LM Link does not identify the actual inference device in the REST response, so
LocalHub cannot prove which linked machine served a request. Set the Mac as the
preferred device in Windows LM Studio and verify it in LM Studio when device
placement matters.

## Commands

| Command | Result |
| --- | --- |
| `lh` | Open the interactive model picker |
| `lh setup` | Guide Windows through LM Link or authenticated direct LAN |
| `lh status` | Print system, route, server, auth, Codex, context, and model state |
| `lh doctor` | Run setup checks and print concise fixes |
| `lh release identity <release-candidate.json>` | Verify the executing assembled asset and print its exact identity |
| `lh evidence validate <release-candidate.json> <evidence.json>` | Reject stale, malformed, sensitive, or mismatched evidence |
| `lh --help` | Show usage and keys |
| `lh --version` | Print the LocalHub version |

`lh status` exits nonzero when the LM Studio route or Codex is unavailable.
`lh doctor` exits nonzero when any check fails.

### TUI keys

| Key | Action |
| --- | --- |
| `↑` / `↓` or `j` / `k` | Select an installed LLM |
| `r` | Refresh system, route, and model state |
| `l` | Load or reload the selection at the configured context |
| `u` | Unload every loaded instance of the selection |
| `d` | Toggle diagnostics |
| `Enter` or `c` | Verify/load the selection and launch Codex |
| `q`, `Esc`, or `Ctrl-C` | Quit |

## Configuration

LocalHub works without a configuration file. Defaults:

```json
{
  "contextLength": 65536,
  "localEndpoint": "http://127.0.0.1:1234",
  "tokenEnv": "LM_API_TOKEN"
}
```

See [config.example.json](config.example.json) for a Windows direct-LAN
fallback example.

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/LocalHub/config.json` |
| Windows | `%APPDATA%\LocalHub\config.json` |
| Any platform with `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/localhub/config.json` |

The XDG location takes precedence when set.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `contextLength` | positive integer | `65536` | Exact context requested and verified during load |
| `localEndpoint` | HTTP(S) origin | `http://127.0.0.1:1234` | Local LM Studio origin; do not append `/v1` |
| `lanEndpoint` | HTTP(S) origin | unset | Windows-only direct-LAN fallback |
| `tokenEnv` | environment-variable name | `LM_API_TOKEN` | Variable from which LocalHub reads a token |
| `selectedModel` | non-empty string | unset | Preferred LM Studio model key; saved after a successful load |

Unknown keys are rejected. Origins cannot contain credentials, a path, query,
or fragment. Never add a token to this file.

`lh setup` and interactive `lh` can read a direct-LAN token with hidden input
and keep it only for that process. For scripts, set the token only for the
current shell. For example:

```sh
export LM_API_TOKEN='replace-with-your-token'
lh doctor
```

In PowerShell:

```powershell
$env:LM_API_TOKEN = 'replace-with-your-token'
lh doctor
```

## Codex isolation and compatibility

LocalHub launches Codex with process-scoped command-line configuration:

- a temporary `localhub_lmstudio` provider using LM Studio's
  OpenAI-compatible `/v1/responses` endpoint;
- the verified loaded instance ID as the model;
- the calling directory through `--cd`;
- the configured context window;
- `service_tier=default` and fast mode off for the local session; and
- web search disabled for the local session.

LocalHub never writes `~/.codex/config.toml` and does not change login or
hosted-provider credentials. Running plain `codex` later behaves exactly as it
did before.

Codex tool quality still depends on the model. LocalHub warns when LM Studio
reports `trained_for_tool_use=false` or omits the capability, but does not
block launch. Test a real tool call before relying on a model for repository
changes.

## Initial validation model: Qwen3.6

The recommended first-run model is
[`qwen/qwen3.6-35b-a3b`](https://lmstudio.ai/models/qwen/qwen3.6-35b-a3b),
using exactly
[`lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit`](https://huggingface.co/lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit).
The upstream base model has 35 billion total parameters, activates 3 billion
per token, and supports 262,144 tokens. LocalHub requests a minimum of 65,536
tokens, keeps that as Codex's process budget, uses thinking on and
preserve-thinking off, and relies on the Apple-silicon MLX runtime. Qwen
recommends at least 128K context for maximum thinking headroom; LM Studio
currently expands this request to 258,816.

The synthetic test fixture mirrors the exact target's catalog metadata and
verifies native v1 parsing, MLX/6-bit presentation, reasoning defaults,
minimum 65,536-token loading, expanded-runtime handling, state transitions,
routing, TUI rendering, and Codex process construction. It does not make
production model selection special.

Live Responses and Codex tool-loop checks remain manual integration tests
because mocked unit tests cannot prove inference quality. LocalHub always uses model
keys, loaded instance IDs, variants, and capabilities returned by LM Studio,
so another compatible installed LLM follows the same path without a code
change.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Cannot connect on Mac | Start LM Studio's Developer server or run `lms server start --port 1234` |
| Windows local route fails | Start the Windows server; if using LM Link, confirm the link and preferred Mac |
| Token missing or rejected | Rerun `lh` for hidden entry, or set the variable named by `tokenEnv`; verify token permissions |
| Mac hostname does not resolve | Fix local DNS/mDNS or use the Mac's LAN IP in `lanEndpoint` |
| LAN route times out | Enable Serve on Local Network and allow TCP port `1234` through the Mac firewall |
| Context is unsupported | Select a model with a larger maximum or lower `contextLength` |
| Codex tools are unreliable | Prefer `trained_for_tool_use=true`, update LM Studio, and test the model's tool calling |
| `codex` is missing | Install Codex, reopen the terminal, and verify `codex --version` |

Run `lh doctor` after each setup change.

## Known limitations

- The supported LocalHub targets are macOS arm64 and Windows x64; Linux is not
  currently packaged or supported.
- macOS reports reliable total memory only. Windows reports free and total
  memory.
- LM Link placement cannot be verified through the model-management response.
- Direct-LAN HTTP is authenticated but unencrypted.
- Capability metadata is descriptive, not a guarantee of correct Codex tool
  calls.
- LM Studio's MLX runtime may expand a requested context. LocalHub accepts a
  larger value, reports it, and rejects only a runtime below the configured
  minimum.
- LocalHub does not manage model downloads, LM Studio runtimes, server
  security settings, Mac firewall rules, or Codex installation. `lh setup`
  only runs explicit Windows LM Studio link/server commands after prompting.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run build
bun run candidate:assemble
```

`bun run check` runs formatting checks, linting, strict TypeScript checking,
and focused Bun tests. The tests mock network and process boundaries; they do
not claim live LM Studio, LM Link, model-quality, or physical-device coverage.
`bun run build` produces the standalone executable for the current host and
smoke-tests it. macOS builds receive an ad hoc signature; Windows builds are
unsigned. From a clean exact commit, `bun run candidate:assemble` creates the
macOS arm64 expand-phase candidate record, manifest, and copied executable
under `dist/candidates/`. It records future v1 dependency pins without claiming
that unshipped runtimes are present. CI drives the assembled binary's public
identity, help, version, status, and evidence-validation commands, then retains
the sanitized candidate/evidence artifact. Controlled-dependency results remain
explicitly ineligible as release evidence. CI also builds and smoke-tests the
legacy executable on each native host.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Source-of-truth documentation

- LM Studio [native v1 REST API](https://lmstudio.ai/docs/developer/rest),
  [list](https://lmstudio.ai/docs/developer/rest/list),
  [load](https://lmstudio.ai/docs/developer/rest/load), and
  [unload](https://lmstudio.ai/docs/developer/rest/unload)
- LM Studio [API authentication](https://lmstudio.ai/docs/developer/core/authentication),
  [LM Link](https://lmstudio.ai/docs/lmlink),
  [preferred devices](https://lmstudio.ai/docs/lmlink/basics/preferred-device),
  and
  [Serve on Local Network](https://lmstudio.ai/docs/developer/core/server/serve-on-network)
- LM Studio's [Codex integration](https://lmstudio.ai/docs/integrations/codex)
- LM Studio's
  [Qwen3.6 35B-A3B recipe](https://lmstudio.ai/models/qwen/qwen3.6-35b-a3b)
  and the exact
  [MLX 6-bit artifact](https://huggingface.co/lmstudio-community/Qwen3.6-35B-A3B-MLX-6bit)
- Qwen's
  [Qwen3.6 35B-A3B model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B)
- Codex [advanced configuration](https://developers.openai.com/codex/config-advanced)
  and [configuration reference](https://developers.openai.com/codex/config-reference)
- OpenTUI [standalone executable guidance](https://opentui.com/docs/reference/standalone-executables/)

## License

[MIT](LICENSE) © 2026 Shane Walker
