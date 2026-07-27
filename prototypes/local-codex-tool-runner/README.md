# Local Codex Tool Runner journey prototype

**Prototype question:** Does a seven-stage terminal journey make it clear that
LocalHub supplies Host inference while Codex tools, sandboxing, approvals, and
workspace changes stay on the Member computer? The journey must fail closed on
an incompatible package, failed Host discovery, an unproven Shared Model, or a
missing sandbox; expose Request Queue and reconnect behavior; and prove on exit
that ordinary Codex state was not loaded or changed.

This is a throwaway, in-memory decision artifact for
“Prototype the local Codex Tool Runner journey.” It installs nothing, contacts
nothing, and changes no files.

Run it from this branch with:

```sh
bun run prototype:tool-runner
```

Use `n` to follow the recommended path. At each stage, use `f` to expose the
important failure and its recovery. Use `p` on the first stage to inspect
macOS, native Windows, and WSL2 wording.
