# Contributing

LocalHub is intentionally small. Changes should directly improve its single
workflow: inspect LM Studio, load one selected LLM at an exact context, and run
Codex in the same terminal and directory.

Keep these out of scope: daemons, web UIs, model downloading, telemetry,
accounts, hosted-provider management, databases, updaters, plugin systems, and
speculative abstraction.

## Development

Requirements:

- Bun 1.3.14 or newer
- macOS arm64 or Windows x64 for platform behavior
- LM Studio and Codex only for live integration checks

Install locked dependencies:

```sh
bun install --frozen-lockfile
```

Run the complete local gate:

```sh
bun run check
```

That checks formatting, linting, TypeScript, and tests. Build the standalone
executable for the current native target with:

```sh
bun run build
```

Generated files under `dist/` are not committed.

## Change guidance

- Keep boundaries mockable and tests deterministic.
- Add focused tests for configuration, routing, LM Studio payload parsing,
  state transitions, or Codex process construction when changing those areas.
- Keep model discovery data-driven. A model name or key may appear in a
  synthetic fixture, but never add production matching for Kimi 3 or another
  catalog entry.
- Follow the current official LM Studio native v1 API and Codex configuration
  reference. Do not infer response fields from older `/api/v0` examples.
- Never put secrets in fixtures, snapshots, command arguments, or
  configuration examples.
- Avoid unrelated refactors and new dependencies.

Before proposing a change, run `bun run check` and the relevant standalone
build on its native operating system. Describe any live LM Studio or Codex
check separately from mocked test coverage.

Report security issues using [SECURITY.md](SECURITY.md), not a public bug
report.
