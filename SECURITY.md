# Security policy

## Supported code

Until LocalHub has a tagged stable release, security fixes target the current
`main` branch.

## Report a vulnerability

Use GitHub private vulnerability reporting: **Security → Advisories → Report a
vulnerability**. If private reporting is unavailable, open a public issue that
asks the maintainer for a private contact channel. Do not include exploit
details, credentials, hostnames, model prompts, or logs in a public issue.

Report vulnerabilities in LM Studio or Codex to their respective maintainers
unless LocalHub causes the issue.

## Secrets

LocalHub does not store API tokens. Configuration rejects credentials embedded
in endpoint URLs and rejects unknown keys, including a `token` key.

- Put the token only in the environment variable named by `tokenEnv`
  (`LM_API_TOKEN` by default).
- Use a dedicated LM Studio token with only the permissions needed to list,
  load, unload, and run models.
- Do not commit tokens, paste them into issue logs, or place them in
  `config.json`.
- LocalHub forwards the token to the launched Codex child as
  `LOCALHUB_LMSTUDIO_TOKEN`; the token is not placed in Codex arguments or
  written to Codex configuration.

Environment variables remain visible to the child process and may be visible
to other processes owned by the same operating-system user. Run LocalHub only
from a trusted account and terminal.

## Network boundary

The default endpoint is loopback-only. A direct-LAN route expands the attack
surface:

- LocalHub refuses to use `lanEndpoint` without a bearer token. It first probes
  without credentials and requires a `401` or `403`, then retries with the
  bearer token; an anonymously accessible LAN server is rejected.
- Plain `http://` does not encrypt the token, prompts, responses, or tool
  traffic. Use direct LAN only on a trusted, firewalled network.
- Prefer LM Link when practical; LM Studio documents it as end-to-end
  encrypted.
- Never expose the LM Studio port directly to the public internet.

Local models can emit malicious or mistaken tool calls. Codex and its tools run
with the calling user's permissions on the calling machine. Review proposed
actions and keep Codex sandbox and approval settings appropriate for the
project.
