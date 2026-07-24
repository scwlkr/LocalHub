# LocalHub

LocalHub is a tiny open-source terminal UI, installed as `lh`, that connects
Codex to an LM Studio model without changing your normal Codex setup.

Run it from a project directory to inspect the machine, route, server, Codex,
memory, and installed models; select an LLM; load it at an exact context; then
hand the terminal to Codex in that same directory. Inference can stay on a
64 GB Apple-silicon Mac while Codex and its tools run on either the Mac or a
Windows workstation.

## Behavior

- Discovers models from LM Studio at `GET /api/v1/models`; there is no
  hardcoded model catalog.
- Shows installed and loaded models, quantization, size, maximum and loaded
  context, format, and advertised vision, reasoning, and tool-use
  capabilities.
- Defaults to a 65,536-token context.
- Reuses an instance already loaded at that exact context. Otherwise it
  unloads the selected model's existing instances, loads it with
  `echo_load_config`, and verifies LM Studio applied the requested context.
- Tears down the alternate screen before starting Codex with inherited
  standard input/output/error. LocalHub returns Codex's exit code when Codex
  exits.
- Saves only non-secret preferences in the standard per-user configuration
  directory.

LocalHub does not download models and has no daemon, service, account,
telemetry, database, web UI, or hosted-provider manager.

## Requirements

- macOS arm64 or Windows x64
- [LM Studio](https://lmstudio.ai/) 0.4.15 or newer
- The current [Codex CLI](https://developers.openai.com/codex/cli), available
  as `codex` on `PATH`
- At least one LLM already installed in LM Studio
- A model whose maximum context is at least the configured context; native
  tool-use training is strongly preferred

LM Studio introduced its native v1 management API in 0.4.0. Version 0.4.15 is
recommended because its
  [release notes](https://lmstudio.ai/changelog/lmstudio-v0.4.15) include a fix
for a Codex tool-type error. Standalone LocalHub binaries do not require Bun;
building from source requires Bun 1.3.14 or newer.

## LM Studio preparation

LocalHub manages already-installed models; it does not install LM Studio,
download model weights, create links, or change server security settings.

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
  linked device. LM Link is optional.
- **Direct LAN fallback:** on the Mac, enable **Serve on Local Network**,
  require authentication, create an API token with model permissions, and
  allow the server port through the Mac firewall. Set `lanEndpoint` on
  Windows and expose the token only through the configured environment
  variable.

Direct LAN requires no LM Link dependency. Plain HTTP is not encrypted, so use
it only on a trusted LAN. See [SECURITY.md](SECURITY.md).

## Route selection

| Caller | Order | Authentication |
| --- | --- | --- |
| macOS | `localEndpoint` only | Anonymous first; retries with `tokenEnv` after an authentication response |
| Windows | `localEndpoint` first (local LM Studio or LM Link) | Anonymous first; retries with `tokenEnv` after an authentication response |
| Windows fallback | `lanEndpoint`, when configured | Token required before any request |

A successful model inventory request is the server-health check. LocalHub
reports authentication, DNS, firewall, host, HTTP, timeout, malformed-response,
and unsupported-context failures with a focused fix.

LM Link does not identify the actual inference device in the REST response, so
LocalHub cannot prove which linked machine served a request. Set the Mac as the
preferred device in Windows LM Studio and verify it in LM Studio when device
placement matters.

## Commands

| Command | Result |
| --- | --- |
| `lh` | Open the interactive model picker |
| `lh status` | Print system, route, server, auth, Codex, context, and model state |
| `lh doctor` | Run setup checks and print concise fixes |
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

Set the token only for the current shell. For example:

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

## Kimi 3

Kimi 3 is the first documented target, not a special case in production code.
The test suite uses a synthetic response named `Kimi 3` with a deliberately
fake runtime key. It verifies native v1 model parsing, quantization and
capabilities, exact 65,536-token loading, state transitions, TUI rendering, and
Codex process construction.

That fixture does not claim an official Kimi 3 catalog ID, prove that a
particular quantization fits a machine, or replace live tool-call testing.
LocalHub always uses the keys and capabilities returned by your LM Studio
server, so the same path works for any compatible LLM.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Cannot connect on Mac | Start LM Studio's Developer server or run `lms server start --port 1234` |
| Windows local route fails | Start the Windows server; if using LM Link, confirm the link and preferred Mac |
| Token missing or rejected | Set the variable named by `tokenEnv`; verify token permissions and recreate an expired/revoked token |
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
- LocalHub does not manage model downloads, LM Studio runtimes, server
  lifecycle, links, firewalls, or Codex installation.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

`bun run check` runs formatting checks, linting, strict TypeScript checking,
and focused Bun tests. The tests mock network and process boundaries; they do
not claim live LM Studio, LM Link, model-quality, or physical-device coverage.
`bun run build` produces the standalone executable for the current host and
smoke-tests it. macOS builds receive an ad hoc signature; Windows builds are
unsigned. CI is configured to build and smoke-test each target on its native
host.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Source-of-truth documentation

- LM Studio [native v1 REST API](https://lmstudio.ai/docs/developer/rest),
  [list](https://lmstudio.ai/docs/developer/rest/list),
  [load](https://lmstudio.ai/docs/developer/rest/load), and
  [unload](https://lmstudio.ai/docs/developer/rest/unload)
- LM Studio [API authentication](https://lmstudio.ai/docs/developer/core/authentication),
  [LM Link](https://lmstudio.ai/docs/developer/core/lmlink), and
  [Serve on Local Network](https://lmstudio.ai/docs/developer/core/server/serve-on-network)
- LM Studio's [Codex integration](https://lmstudio.ai/docs/integrations/codex)
- Codex [advanced configuration](https://developers.openai.com/codex/config-advanced)
  and [configuration reference](https://developers.openai.com/codex/config-reference)
- OpenTUI [standalone executable guidance](https://opentui.com/docs/reference/standalone-executables/)

## License

[MIT](LICENSE) © 2026 Shane Walker
