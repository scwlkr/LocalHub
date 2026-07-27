# Codex and llama.cpp compatibility proof

Date: 2026-07-26

Status: planning evidence for “Prove the Codex and llama.cpp compatibility seam.” This branch contains no LocalHub product code.

## Decision

Codex 0.145.0 and llama.cpp b10107 have a compatible HTTP/SSE Responses transport, but transport compatibility does not prove that a model and chat template are Codex-capable.

The v1 Tool Runner contract is therefore constrained as follows:

1. A Tool Runner owns local file and shell execution. The Host runs inference only.
2. `lh codex` must start a child with a temporary, child-only `CODEX_HOME`, scrub inherited `CODEX_*` values, and leave ordinary Codex configuration and authentication untouched.
3. The child must send no OpenAI authorization credential to the LocalHub provider. Plugins, remote plugins, skill discovery, multi-agent namespaces, MCP servers, hosted search, unified exec, and Responses WebSockets remain off until explicitly supported.
4. Only a model and exact chat template that pass the real function-call Profile Test may be advertised as Codex-capable. A model name or llama.cpp's `supports_tools` metadata is not proof.
5. Native Windows requires the complete Codex package and its one-time elevated sandbox setup. WSL2 requires the complete Linux package with bundled `bwrap`. The standalone executables are insufficient for these sandboxed paths.
6. The Tool Runner must continue surfacing queue keepalives, cancellation, context overflow, and tool-output errors. Full gateway deadlines remain an acceptance test for the later prototype.

## Pinned baselines

| Component | Pin | Evidence |
| --- | --- | --- |
| Codex | `0.145.0` | Exact release binary on macOS, native Windows, and WSL2 |
| llama.cpp | `b10107`, build `c0bc8591e` | Official release binaries; Host launched without `--tools` or `--agent`, with explicit `--no-agent` |
| macOS Host | Apple arm64, macOS 27.0.0 | Local deterministic suite and real-model runs |
| Native Windows client | AMD64, Windows Server 2025 | Standard GitHub-hosted public-repository runner |
| WSL2 client | Ubuntu 24.04 on WSL2 | Ephemeral imported distribution on the same Windows runner |

[GitHub documents that standard hosted runners are free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions). This proof uses no cache, uploaded artifact, paid API, hosted inference, or billing credential.

## Deterministic Responses proof

The fake server waits five seconds using SSE comments, asks Codex for one `shell_command`, receives the `function_call_output`, and then completes the response. Separate cases return a context-length error and hold a stream open until the client cancels.

| Behavior | macOS | Native Windows | WSL2 |
| --- | --- | --- | --- |
| `POST /v1/responses` with streaming SSE | Pass | Pass | Pass |
| Function-call round trip | Pass | Pass | Pass |
| File created only in Member workspace | Pass | Pass | Pass |
| Host workspace unchanged | Pass | Pass | Pass |
| Outside-workspace write denied | Pass | Pass | Pass |
| Five-second queue keepalives tolerated | Pass | Pass | Pass |
| Client cancellation disconnects stream | Pass | Pass | Pass |
| Context error surfaced and exits nonzero | Pass | Pass | Pass |
| Authorization header absent | Pass | Pass | Pass |
| Advertised tool types are function-only | Pass | Pass | Pass |

The exact function names visible to the isolated client were `request_user_input`, `shell_command`, `update_plan`, and `view_image`. No namespace tool was advertised.

On the Mac with an existing normal Codex installation, `config.toml` and `auth.json` remained byte-identical and `codex doctor` still reported the normal OpenAI provider and credential as healthy. The clean Windows and WSL2 runners began without ordinary Codex state and remained unchanged outside the child-only home.

Native Windows additionally proved that the complete Codex package can provision the elevated sandbox, write inside the Member workspace, and return `PermissionError` for an outside-workspace write.

## Real-model profiles

All servers were loopback-only, exact-context, single-slot profiles with fit disabled and no Host-side tools.

| Client | Model and template | Context | Result |
| --- | --- | ---: | --- |
| macOS | Qwen2.5-Coder 7B Instruct Q4_K_M, SHA-256 `60e05f2100071479f596b964f89f510f057ce397ea22f2833a0cfe029bfc2463` | 32,768 | Response completed as a message; no `function_call`; Codex created no marker |
| macOS | llama3-groq-tool-use 8B Q4_0, SHA-256 `23e78d0ea1ab895bcbe63a12422a731cfd2b1a8bd124a1c91790b2b9c3fc9d14` | 8,192 | Embedded template ignored tools; response completed as a message; Codex created no marker |
| Native Windows | Qwen2.5-Coder 0.5B Instruct Q4_K_M, SHA-256 `1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32` | 32,768 | Response completed as a message; no `function_call`; Codex created no marker |

The Windows `llama-server.exe` SHA-256 was `af3e56d6bdb84a9b6bd50f6ad748809370bc29be42d58088041408b2933d80f7`. The tested macOS `llama-server` SHA-256 was `a4998768a70ba2be02617ec9d8773accc2952516f4f5a8f38f621ece54cbf04b`.

None of these three profiles is proven Codex-capable. The negative results are catalog evidence, not transport failures.

## Unsupported and deferred surface

- Process-scoped provider overrides alone are unsafe. With the ordinary parent environment and Codex home, the local provider received an existing Bearer credential and Codex exposed installed namespace tools. No credential value was retained. Child-home isolation, inherited `CODEX_*` scrubbing, an empty MCP map, and explicit feature disables removed both behaviors.
- `model_supports_reasoning_summaries=false` is not a valid strict Codex 0.145.0 setting. It must not appear in the v1 launch recipe.
- llama.cpp b10107 does not make a profile tool-capable by reporting `supports_tools=true`; the exact template and real function behavior remain decisive.
- Five-second keepalives prove the client behavior, not the full 10-minute load and 30-minute wait/run deadlines. The gateway prototype must exercise the complete deadlines.
- Cancellation proves that Codex disconnects the waiting Responses stream. The gateway's ten-second llama.cpp slot-release rule remains a later end-to-end acceptance test.
- Hosted search, MCP/app namespaces, plugins, skills, multi-agent tools, image-history services, and Responses WebSockets are outside this proven seam.

## Reproduction

```text
python3 scripts/research/codex_compat_probe.py fake-suite --codex /path/to/codex
python3 scripts/research/codex_compat_probe.py real-smoke --codex /path/to/codex --base-url http://127.0.0.1:PORT/v1
```

Research branch: `research/codex-llama-compat`

Cross-platform run: [macOS-derived harness, native Windows real model, and WSL2 deterministic suite](https://github.com/scwlkr/LocalHub/actions/runs/30234956512)
