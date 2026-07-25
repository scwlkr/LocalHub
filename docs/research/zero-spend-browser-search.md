# Zero-spend Browser Chat web search

Research date: 2026-07-25
Decision ticket: [Research zero-spend Browser Chat web search](https://github.com/scwlkr/LocalHub/issues/3)

## Recommendation

Use a **pinned, unmodified SearXNG sidecar** as LocalHub v1's search-result
backend. Bundle it with LocalHub's Apple-silicon Mac distribution, run it as a
separate loopback-only process, and call its JSON API through a narrow
LocalHub-owned facade. Do not require Docker, expose SearXNG on the LAN, use a
public SearXNG instance, or fall back to a paid, metered, key-based, or hosted
search API.

SearXNG should discover result URLs and snippets. LocalHub should own the
security-sensitive parts: request limits, public-web-only page fetching,
untrusted-content framing, source IDs, citations, and Member-facing failure
states. This preserves the decided boundary that Browser Chat can read the
public web but cannot reach Host files, shell commands, or private-LAN devices.

This is permanently zero-spend in the billing sense: all software runs on the
Host Computer and the default path has no API account, key, credit, trial,
meter, billing method, or automatic paid fallback. It is **not fully offline**
and cannot promise permanent search availability. SearXNG is a metasearch
broker, not a local copy of the web; its API explicitly passes the query to
external search services. Those services can change, rate-limit, CAPTCHA, or
block the Host's public IP
([SearXNG Search API](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/docs/dev/search_api.rst#L44-L49),
[private-instance consequences](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/docs/own-instance.rst#L45-L55)).
LocalHub must treat degraded or unavailable search as normal and visible, never
silently substitute a billable provider.

## Why the Odysseus example is useful

Odysseus validates the basic composition, not a drop-in implementation:

- It runs a deliberately pinned SearXNG image, generates a secret, and binds
  the service to `127.0.0.1`
  ([Compose service](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/docker-compose.yml#L93-L120)).
- It enables SearXNG's JSON output and calls `/search` with ordinary query,
  language, category, and safe-search parameters, then preserves each result's
  title, URL, and snippet
  ([SearXNG settings](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/config/searxng/settings.yml#L1-L9),
  [provider adapter](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/services/search/providers.py#L135-L195)).
- Its production experience also shows why engine names cannot be treated as a
  permanent guarantee: engines that were defaults became CAPTCHA- or
  rate-limit-prone, so it pins a different set and still reports empty or
  unresponsive engines
  ([engine selection](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/services/search/providers.py#L124-L132),
  [failure reporting](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/services/search/providers.py#L227-L242)).
- It treats fetched pages as untrusted model input and keeps raw internal
  services outside its exposed boundary
  ([threat model](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/THREAT_MODEL.md#L5-L12),
  [untrusted-content boundary](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/THREAT_MODEL.md#L54-L61)).

LocalHub should adopt those shapes but not Odysseus's Docker dependency,
disk-backed search cache, broad provider fallback chain, account model, or
privileged agent tools.

## V1 architecture

```text
Member browser on trusted LAN
        |
        | LocalHub Browser Tool request
        v
LocalHub LAN gateway
  - allowlisted search inputs
  - global/member limits
  - in-memory request state only
        |
        | fixed loopback JSON call
        v
Pinned SearXNG sidecar on 127.0.0.1
        |
        | queries selected no-key public engines
        v
Public search services

Result URLs -> LocalHub public-page fetcher -> untrusted source blocks
           -> model inference -> validated source IDs -> Browser Chat links
```

The SearXNG process should use an ephemeral or reserved loopback port, a random
per-install secret, `public_instance: false`, JSON as the only required output,
no autocomplete, no favicon resolver, and no image proxy. Upstream defaults
already bind to `127.0.0.1`, default public-instance mode and image proxy to
false, and make output formats explicit
([default server/search settings](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/settings.yml#L83-L107)).
LocalHub should still ship its own minimal locked configuration rather than
relying on defaults.

Only the LocalHub process may call SearXNG. The Browser Tool endpoint accepts a
query plus bounded product-level choices such as safe-search and freshness; it
does not accept a backend URL, proxy, arbitrary SearXNG parameter, engine
definition, plugin, or Host path. The SearXNG client must disable redirects and
require a successful JSON response. SearXNG supports GET and POST, but LocalHub
should use POST so the query is not put in an access-log URL
([official API shape](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/docs/dev/search_api.rst#L7-L16)).

### Public-page fetching and private-LAN isolation

Search results are attacker-controlled URLs. A Host-side fetcher creates an
SSRF path unless it fails closed. Every initial URL and every redirect hop must:

1. allow only `http` and `https`;
2. resolve DNS before connection and reject the request if **any** answer is
   loopback, private, link-local, shared/CGNAT, multicast, reserved, or
   unspecified, including IPv4-mapped IPv6;
3. pin the TCP connection to the checked address so DNS rebinding cannot swap
   the destination between validation and connection;
4. re-run the same checks on every redirect and enforce a small redirect cap;
5. enforce connect/read/total timeouts, a small concurrency limit, and a strict
   streamed response-size cap; and
6. accept only expected document content types, parse without executing script,
   and never forward Host cookies, credentials, or LAN headers.

Odysseus provides a concrete implementation reference for special-address
rejection and DNS checks
([address checks](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/services/search/content.py#L32-L115))
and for DNS-pinned, manually revalidated redirects plus bounded streaming
([fetch path](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/services/search/content.py#L286-L360)).
That is a useful minimum, not proof that LocalHub's future implementation is
safe; LocalHub needs its own adversarial tests.

Do not use SearXNG's image or favicon proxies in v1. Its image-proxy route is
another Host-side fetcher that follows redirects
([route](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/webapp.py#L988-L1016)).
LocalHub does not need that surface for text search.

## Search engines, rate limits, and zero-spend enforcement

The configured engine set is a release artifact, not a hidden runtime choice.
For every included engine, release verification must confirm that its SearXNG
connector needs no API key, account, payment method, credits, subscription, or
metered endpoint. Engines with ambiguous pricing or a possible paid fallback
stay disabled. The Host may disable engines; v1 should not let Members enable
new ones.

No fixed engine set can be certified permanently reliable. SearXNG itself
models upstream access denial, CAPTCHA, and HTTP 429 as suspension conditions
([engine exceptions](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/exceptions.py#L60-L110))
and ships configurable suspension periods
([settings](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/settings.yml#L65-L81)).
Its own documentation explains that a SearXNG instance looks like a bot to
origin engines and may be CAPTCHA-blocked
([limiter rationale](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/limiter.py#L1-L21)).

V1 should therefore have:

- a low global search-concurrency cap and a per-browser rate limit enforced by
  LocalHub before SearXNG;
- short-lived in-memory deduplication/cache only, cleared when LocalHub stops,
  so Member queries and results are not persisted;
- a circuit breaker per engine and no automatic retry storm;
- a Host-visible health view showing enabled, responding, suspended, or
  blocked engines without showing Member query text; and
- a Member-facing state such as “Search is temporarily unavailable; no paid
  fallback was used,” rather than an answer that pretends to be current.

SearXNG's own IP limiter requires a Valkey database
([limiter setup](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/limiter.py#L42-L59)).
Because the sidecar is loopback-only and LocalHub is the sole caller, LocalHub
can enforce Member and global limits at its facade and omit a separate Valkey
daemon in v1. This should be revisited only if raw SearXNG ever becomes exposed,
which this decision rejects.

## Privacy and untrusted content

Self-hosting removes a third-party SearXNG operator, but it does not hide web
search from the selected origin engines. SearXNG says it strips cookies,
randomizes the browser profile, and presents the instance's IP; the search
service still receives the query
([privacy behavior](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/docs/own-instance.rst#L21-L42)).
Browser Chat should explain this once when search is enabled: search terms and
the Host's public IP leave the Host Computer.

LocalHub must not persist Member queries, search results, fetched pages, or
model answers on the Host. Keep them in memory for the active request or a
short deduplication TTL, exclude them from normal logs and Host dashboard
details, and clear them on stop. Operational counters may retain engine name,
status, duration, byte count, and failure class without query text or URLs.

All snippets and fetched page text are untrusted data. They must be placed in a
bounded tool/user-data block, never a system or developer instruction, and
must not grant the model a path to Host tools. Odysseus uses this same boundary
for web content
([prompt wrapper](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/src/prompt_security.py#L8-L26),
[message construction](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/src/prompt_security.py#L64-L85)).

## Citation contract

SearXNG's JSON response contains ordered result records plus the engines that
failed
([JSON response](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/searx/webutils.py#L162-L174)).
LocalHub should convert accepted results into an immutable per-response source
registry:

- assign each accepted canonical public URL a stable source ID such as `S1`;
- keep title, URL, engine provenance, snippet, fetch status, and retrieval time;
- label every model context block with its source ID;
- require the model to cite source IDs, not generate raw citation URLs;
- resolve displayed links only from the server-held source registry and allow
  only `http`/`https` links; and
- show a compact sources panel even when the model fails to cite a used source.

Odysseus demonstrates the useful UI shape of numbered, escaped source links
opened with `noopener noreferrer`
([source renderer](https://github.com/odysseus-dev/odysseus/blob/d8a2059df8e53bc7275c45339849d14c8651e73c/static/js/chatRenderer.js#L945-L975)).
LocalHub should go further by validating the model's source IDs against the
registry. A citation proves which retrieved page supported an answer; it does
not prove that the page is true. If search or page retrieval fails, LocalHub
must say so and must not attach unrelated results as cosmetic citations.

## Licensing and distribution

SearXNG is AGPL-3.0-or-later, while LocalHub currently declares MIT. Keep the
sidecar a clearly separate program communicating over loopback HTTP; do not
copy SearXNG code into LocalHub or create a combined in-process derivative as
part of this decision. This is a product/licensing boundary, not legal advice.

Bundling a SearXNG executable or runtime still carries distribution duties.
The AGPL requires equivalent access to Corresponding Source when conveying
object code
([AGPL section 6](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/LICENSE#L233-L274)).
If LocalHub modifies SearXNG, remote users must be prominently offered the
Corresponding Source of that modified version
([AGPL section 13](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/LICENSE#L540-L559)).

The release must therefore preserve SearXNG notices and license, identify the
exact pinned commit/version, and provide the corresponding source plus any
build scripts and LocalHub-carried patches next to every distributed binary.
Prefer no patches. Add a visible “SearXNG source and license” link in Host and
Member legal/about UI. Obtain a focused license review before distributing the
first bundle.

## Deployment footprint

The upstream native package requires Python 3.10 or newer and a non-trivial set
of pinned Python libraries
([package metadata](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/setup.py#L18-L43),
[runtime requirements](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/requirements.txt#L1-L19)).
The official container composition adds a SearXNG service and a Valkey service
([Compose definition](https://github.com/searxng/searxng/blob/0909dbc9efb2c6e93e2ad51e60e66417ab291710/container/docker-compose.yml#L4-L28)).

LocalHub's “one download, no Docker or source build” decision means the v1 Mac
artifact must include a tested arm64 Python runtime, the pinned SearXNG package
and dependencies, a production server, minimal configuration, licenses, and
corresponding source. The sidecar starts and stops with the explicit LocalHub
Run. Valkey, SearXNG's full browser UI, and public-instance components are not
needed for this LAN facade. Exact bundle size, memory at idle/load, startup
time, and code-signing/notarization behavior remain prototype acceptance
measurements; upstream documentation does not provide decision-quality Mac
bundle numbers.

## Options considered

| Option | Zero-spend | Privacy/control | Install fit | Reliability | Decision |
| --- | --- | --- | --- | --- | --- |
| Pinned bundled SearXNG sidecar + guarded LocalHub fetcher | Yes: no account, key, meter, or paid fallback | Strongest practical control; queries still reach origin engines | Requires bundled Python/runtime, but can remain one download | Best-effort; engines may block | **Choose for v1** |
| Public SearXNG instance | Usually no invoice, but current cost/availability is outside LocalHub's control | Must trust unknown operator with queries/logging | Smallest bundle | Public formats may be disabled; abuse can reduce results | Reject as default or fallback |
| Hosted search API/free tier | Quota/meter/billing can change and violates the permanent boundary | Adds hosted provider and keys | Easy technically | Provider-dependent | Reject |
| Direct bespoke scraping adapters in LocalHub | No invoice if keyless | Local control | Smaller runtime initially | High maintenance; duplicates SearXNG's engine/block handling | Reject for v1 |
| Fully local crawler/index | No search API | Maximum local control after crawl | Large crawl, storage, ranking, and freshness burden | Cannot provide broad fresh web search in v1 | Defer beyond v1 |

## Implementation gates created by this decision

This research resolves the backend shape, but implementation should not be
accepted until all of these are proven:

1. A pinned arm64 SearXNG sidecar installs and launches with `lh` without
   Docker, a source build, an account, or a billing method.
2. The raw sidecar is reachable only from the Host loopback; a LAN Member can
   reach only LocalHub's bounded Browser Tool facade.
3. The enabled-engine manifest has a release-time zero-cost/no-key review, and
   paid or ambiguous providers cannot be selected or reached as fallback.
4. Engine block, CAPTCHA, timeout, empty-result, and total outage paths produce
   honest degraded states with no silent substitution.
5. SSRF tests cover private/loopback/link-local/shared IPv4, IPv6, mapped
   addresses, mixed DNS answers, DNS rebinding, redirect-to-private, alternate
   schemes, oversized/compressed bodies, slow responses, and redirect loops.
6. Search/page content is bounded and untrusted, cannot invoke Host tools, and
   is absent from persistent logs, cache, history, and Host dashboard content.
7. Citation IDs resolve only to the server-collected source registry and render
   safe links; unsupported claims are not decorated with unrelated citations.
8. The shipped artifact contains SearXNG notices, license, exact version,
   Corresponding Source, and a visible source link; focused license review is
   complete.
9. Bundle size, idle/search memory, first-start latency, signature, and
   notarization are measured on the supported Apple-silicon Host Computer.

## Source quality and limits

All technical claims above are based on upstream SearXNG documentation/source
at commit
[`0909dbc9efb2c6e93e2ad51e60e66417ab291710`](https://github.com/searxng/searxng/commit/0909dbc9efb2c6e93e2ad51e60e66417ab291710)
and the concrete Odysseus implementation at commit
[`d8a2059df8e53bc7275c45339849d14c8651e73c`](https://github.com/odysseus-dev/odysseus/commit/d8a2059df8e53bc7275c45339849d14c8651e73c).
These are primary sources for their own behavior. Odysseus comments about
individual engine reliability are implementation evidence, not a promise from
those engine operators. Upstream pricing, access policy, and blocking behavior
can drift, so the enabled-engine set needs re-verification at each LocalHub
release. Licensing conclusions are conservative engineering guidance, not
legal advice.
