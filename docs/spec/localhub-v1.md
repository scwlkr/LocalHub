# LocalHub v1 Specification

Status: Build-ready parent specification

Canonical source: [closed LocalHub v1 Wayfinder map](https://github.com/scwlkr/LocalHub/issues/1)

Final acceptance authority: [Define the v1 acceptance contract and implementation handoff](https://github.com/scwlkr/LocalHub/issues/13#issuecomment-5093166580)

This specification uses **MUST**, **MUST NOT**, **SHOULD**, and **MAY** normatively. Stable requirement IDs remain attached to their meanings even if this document is reorganized. `D02` through `D19` identify the accepted decision sources in the Source Decision Index; they are not requirement IDs.

## Problem Statement

The Host needs a private household AI environment that runs on an Apple-silicon Mac, offers exact and understandable control over local models, and lets trusted people use those models from ordinary devices on the same LAN. The current `lh` application is an LM Studio-backed terminal model picker and Codex launcher. It does not provide the intended LocalHub product: direct llama.cpp ownership, a persistent Host-controlled Run, verified model acquisition and profiles, fair multi-Member scheduling, Browser Chat, bounded Browser Tools, Host authority controls, release rollback, or a complete local Codex Tool Runner boundary.

The v1 contract must be implementable without inventing product behavior, trust boundaries, platform claims, failure behavior, migration rules, or acceptance evidence. Convenience must never silently widen authority, spend money, persist Member content, substitute a different model or runtime, weaken a sandbox, or turn missing proof into a release claim.

## Solution

LocalHub v1 is a user-space, explicitly started private AI Host for a supported Apple-silicon Mac. It directly supervises a pinned llama.cpp runtime, gives the Host an evidence-first loopback dashboard, and exposes a separate selected-interface Member gateway for no-account Browser Chat on the trusted LAN. The Host acquires exact model bytes, verifies them by content, tests exact Run Profile revisions with automatic fitting disabled, and publishes only currently passing Shared Models and capabilities.

Each Inference Request enters one finite, fair Request Queue. Member content remains browser-local or temporary on the Host. Member Browser Tools are limited to Host-offered, profile-proven groups and public-only temporary state. Host Tools remain loopback-only, begin disabled, and disclose their unsandboxed machine authority. `lh codex` runs a separate caller-local Tool Runner with a disposable credential-free Codex home, the pinned local sandbox, and only profile-proven functions.

The release is accepted only from the assembled release asset on the exact declared platforms. Automated and controlled-failure checks support the proof, but the eight live journey suites and sanitized evidence matrix are the release verdict. The current LM Studio application is migrated explicitly and reversibly; LM Studio, its models, its credentials, and ordinary Codex state remain untouched.

## User Stories

1. As a Host, I want one verified LocalHub release for my Apple-silicon Mac, so that setup does not require a source build or an unreviewed component mix.
2. As a Host, I want the release trust state explained before launch, so that I know whether Apple notarized it.
3. As a Host, I want the checksum, manifest, architecture, and signature verified, so that corrupt or wrong-platform bytes never run.
4. As a Host, I want First Run Setup to ask one decision at a time, so that I can understand each local change.
5. As a Host, I want to choose Model Storage explicitly, so that LocalHub never moves or deletes unrelated files.
6. As a Host, I want LocalHub to verify its pinned llama.cpp runtime, so that model evidence refers to the runtime actually used.
7. As a Host, I want to choose one private network interface, so that Member access does not bind more broadly than intended.
8. As a Host, I want an exact Member Link, IP fallback, and QR code, so that trusted Members can connect without an account.
9. As a Host, I want to start and stop a LocalHub Run explicitly, so that closing a terminal or browser never changes service lifecycle accidentally.
10. As a Host, I want LocalHub to keep running after setup closes, so that Members do not depend on an open terminal.
11. As a Host, I want clear diagnostics and one repair path when setup fails, so that a failure never becomes a hidden fallback.
12. As a Host, I want to acquire one exact Model Variant from a local file, so that LocalHub does not alter the source.
13. As a Host, I want to acquire one exact Model Variant from a public zero-cost HTTPS source, so that downloads never use an account or paid provider.
14. As a Host, I want interrupted acquisitions to resume only when source identity is unchanged, so that uncertain bytes are never concatenated.
15. As a Host, I want every model file and shard verified before installation, so that incomplete data is never loadable.
16. As a Host, I want model identity based on content rather than names or paths, so that renames and verified moves are safe.
17. As a Host, I want exact Run Profile revisions, so that settings do not change beneath existing evidence.
18. As a Host, I want automatic fitting disabled during Profile Tests and Runs, so that LocalHub uses exactly what I approved.
19. As a Host, I want estimates separate from measured Profile Results, so that projections never look like observations.
20. As a Host, I want optional Model Capabilities proven with real behavior, so that metadata does not advertise broken features.
21. As a Host, I want to publish only a passing Shared Model/Profile, so that Members cannot select stale or failed targets.
22. As a Host, I want pin, share, unshare, and replacement actions to be explicit, so that queued work keeps its accepted target.
23. As a Host, I want unavailable storage or models to fail visibly, so that LocalHub never chooses a similar substitute.
24. As a Host, I want a dense Evidence Ledger, so that exact variants, profiles, commands, measurements, warnings, and actions remain inspectable.
25. As a Member, I want Browser Chat to open from the Member Link without installation, so that trusted household access is simple.
26. As a Member, I want to choose a Member Label without creating an account, so that the Host can recognize activity without false identity claims.
27. As a Member, I want to choose only Host-published Shared Models, so that I cannot widen runtime authority.
28. As a Member, I want bounded Conversation Memory, so that I control how much browser history enters a request.
29. As a Member, I want chat history and generated output to remain in my browser, so that the Host does not build a content library.
30. As a Member, I want responsive phone and desktop layouts, so that Browser Chat remains usable on supported devices.
31. As a keyboard or screen-reader user, I want WCAG 2.2 AA behavior, so that the Host and Member surfaces are operable without a mouse or perfect vision.
32. As a Member, I want Attachments to be current-request-only with visible limits, so that nothing is reused without my deliberate resend.
33. As a Member, I want unsupported, oversized, truncated, or excess Attachments identified before inference, so that the model never silently receives different content.
34. As a Member, I want streaming output and visible queue state, so that waiting, loading, running, cancellation, and failure are honest.
35. As a Member, I want reconnect to resume from an event cursor, so that a phone disconnect does not duplicate or cancel inference.
36. As a Member, I want to cancel my own waiting or running request, so that finite work remains under my control.
37. As a Host, I want fair scheduling across exact profiles, so that a popular loaded model cannot starve other requests.
38. As a Host, I want one bounded Run next action, so that I can intervene without continuously starving ordinary work.
39. As a Host, I want impossible pinned-capacity work rejected, so that the queue never promises progress it cannot make.
40. As a Host, I want profile failures isolated, so that unrelated queued work continues.
41. As a Member, I want offered Tool Groups to depend on a passing exact profile, so that unavailable capabilities are not callable.
42. As a Member, I want public Web Search, Fetch, and Research to show validated citations, so that invented sources are visible and rejected.
43. As a Member, I want public-page access isolated from private addresses and Host files, so that Browser Tools cannot reach the household LAN or Host authority.
44. As a Member, I want Browser Automation to use a fresh temporary Browser Session, so that it cannot inherit Host cookies or secrets.
45. As a Member, I want an approval immediately before an external change, so that I see the site, action, and submitted data.
46. As a Host or Member, I want every spend-capable action denied without override, so that LocalHub remains permanently zero-spend.
47. As a Host, I want Web Search to remain optional and disabled without confirmed zero-cost Docker eligibility, so that core LocalHub remains usable.
48. As a Host, I want SearXNG bound to loopback with a pinned image and finite health checks, so that Members never access its raw service.
49. As a Host, I want Host Tools globally disabled by default, so that machine authority is never ambient.
50. As a Host, I want the “Nothing here is a sandbox” acknowledgement, so that unsandboxed Host Tool risk is explicit.
51. As a Host, I want Tool Group and per-tool controls for Shell, Python, Host Files, MCP, and Host Browser, so that enabled authority is exact.
52. As a Host, I want every Host Tool run recorded as observed evidence, so that inputs, outputs, approvals, failures, cancellation, cleanup, and retry are inspectable.
53. As a Member, I want Host Tool and administration routes absent from the Member gateway, so that Browser Chat cannot discover or invoke Host authority.
54. As a Tool Runner user, I want `lh codex` to discover only the Host-provided address, so that it never scans or guesses across the LAN.
55. As a Tool Runner user, I want to choose one explicit local workspace, so that local tool effects have a clear durable boundary.
56. As a Tool Runner user, I want a real passing Codex-capable Shared Model/Profile, so that a chat-only model is never mislabeled as Codex-capable.
57. As a Tool Runner user, I want ordinary Codex credentials and configuration excluded, so that LocalHub cannot forward or mutate my normal Codex state.
58. As a Tool Runner user, I want only proven local functions advertised, so that unavailable tools are omitted rather than failing later.
59. As a Tool Runner user, I want native sandbox prerequisites to fail closed, so that LocalHub never launches unsandboxed as a fallback.
60. As a Tool Runner user, I want approved workspace changes to persist and outside-workspace attempts denied, so that the caller-local sandbox remains authoritative.
61. As a current `lh` user, I want my legacy binary and non-secret configuration backed up before replacement, so that migration is reversible.
62. As a current `lh` user, I want legacy settings shown only as reference, so that no token or LM Studio assumption is silently imported.
63. As a current `lh` user, I want LM Studio, its models, and ordinary Codex state untouched, so that adopting v1 cannot destroy my existing setup.
64. As a Host, I want updates to require review and approval, so that components never change independently or automatically.
65. As a Host, I want activation and state migration failures to restore the prior complete runtime/state pair, so that rollback is atomic.
66. As a Host, I want uninstall to name every removed resource and keep Model Storage by default, so that removal is narrow and recoverable.
67. As a release reviewer, I want every gate tied to an exact candidate and sanitized manifest, so that older or ambiguous evidence cannot pass v1.
68. As a release reviewer, I want deliberate fault injection and adversarial authority tests, so that failure and security claims are observed rather than assumed.
69. As a release reviewer, I want failed attempts retained with their correction and rerun, so that flaky or incomplete evidence is not hidden.
70. As an implementation agent, I want stable requirements and source traces, so that delivery tickets can cite accepted behavior without reopening product decisions.

## Implementation Decisions

### Requirement classification and traceability

- **Mandatory** means every v1 release must implement and pass the requirement.
- **Conditional** means the capability may be unavailable, but its disabled/unavailable behavior is mandatory. If a release advertises or enables it, every enabled-path gate becomes release-blocking.
- **Later** means the behavior must not be implemented implicitly or used to block v1.
- Every requirement names one or more accepted decision sources. The Source Decision Index links the exact resolution comment that owns the decision.

### Product, lifecycle, and release boundary

- **LH-GOV-001 (Mandatory; Sources: D01, D13):** LocalHub v1 MUST be a private household AI Host on one supported Apple-silicon Mac, with trusted-LAN Member access and no public or remote service exposure.
- **LH-GOV-002 (Mandatory; Sources: D01, D02):** LocalHub MUST directly supervise the pinned llama.cpp runtime and MUST NOT use LM Studio as its target runtime or product authority.
- **LH-GOV-003 (Mandatory; Sources: D04, D10):** Host control MUST be reachable only from Host loopback. The Member gateway MUST bind only to one Host-selected private interface and MUST expose no Host management or Host Tool route.
- **LH-GOV-004 (Mandatory; Sources: D04, D11):** The Member Link MUST use the actual Bonjour name when available, show the current private IPv4 fallback, and provide a locally generated QR code. LocalHub MUST NOT scan or guess a LAN address.
- **LH-GOV-005 (Mandatory; Sources: D02, D06, D13):** Each release MUST pin or explicitly version every release-sensitive dependency. A material dependency, model, profile, platform, or trust-state change MUST invalidate the affected evidence.
- **LH-GOV-006 (Mandatory; Sources: D06, D12, D17):** Installation, First Run, update, rollback, Run start/stop, and uninstall MUST require the explicit Host actions defined below. LocalHub MUST NOT auto-start, auto-update, independently pull components, or perform background acquisition.
- **LH-GOV-007 (Mandatory; Sources: D12):** Running `lh` after installation MUST enter the Guided Runway, then start a detached LocalHub Run only after **Start LocalHub**. Closing a setup window, browser, or terminal MUST NOT stop the Run.
- **LH-GOV-008 (Mandatory; Sources: D12, D13):** **Stop LocalHub** MUST reject new work, resolve active work explicitly, close the Member Link, and stop LocalHub-owned workers and optional SearXNG service. It MUST NOT uninstall LocalHub, delete models, remove Docker, or touch outside source files.
- **LH-GOV-009 (Mandatory; Sources: D12, D13):** Every failure MUST name the real cause, protected state, what still works, one repair path, and an explicit recheck. Generic success, hidden downgrade, silent retry, or fallback MUST NOT satisfy a requirement.
- **LH-GOV-010 (Mandatory; Sources: D08, D18):** Production Host and Member surfaces MUST be rebuilt from the accepted interaction directions after a `ui-ux-pro-max` design-system pass; prototypes are interaction references, not production code or release evidence.
- **LH-GOV-011 (Mandatory; Source: D06):** The macOS product MUST ship as one immutable, versioned, user-space release asset with its pinned runtimes, configuration, licenses, and notices. Install and normal Run lifecycle MUST require neither a source build nor `sudo`.
- **LH-GOV-012 (Mandatory; Sources: D04, D12):** When the selected private interface or address changes, LocalHub MUST withdraw the old Member service, close the old listener, and require a verified rebind/republication. Wake/restart MUST recheck the boundary before Member service resumes.

### Release pins and candidate identity

| Requirement | v1 baseline or rule | Source |
| --- | --- | --- |
| **LH-PIN-001** | llama.cpp `b10107`, released build `c0bc8591e`; exact shipped binary and library checksums belong in the candidate manifest | D02, D06, D15 |
| **LH-PIN-002** | Codex `0.145.0`, using the complete pinned package for each supported Tool Runner lane | D05, D15, D19 |
| **LH-PIN-003** | Bun `1.3.14` when the release contains or depends on the Bun runtime; the exact shipped runtime checksum belongs in the manifest | D06 |
| **LH-PIN-004** | SearXNG `docker.io/searxng/searxng:2026.5.31-7159b8aed`, Apple-arm64 manifest `sha256:6b5787eb43a997e1214f627480068396e434b0ba5b3761be382dcd3daa9e006a`; observed compressed size `94,470,218` bytes (`90.1 MiB`) | D14 |
| **LH-PIN-005** | The release MUST declare the exact LocalHub commit, tag, asset, exhaustive manifest, checksums, architecture, minimum/supported macOS, state schema, rollback target, and trust state | D06, D13, D17 |
| **LH-PIN-006** | Exact OS, browser, Docker Compose, Host/Tool Runner hardware, Model Variant hashes, chat template, Run Profile revision, and test date MUST be recorded rather than globally pinned in this document | D09, D13, D14 |
| **LH-PIN-007** | Changing a pin requires an explicit release review and rerun of every affected journey; the release MUST NOT drift to another version, digest, architecture, model, profile, or template | D09, D13, D14, D15 |

### Zero-spend and release trust

- **LH-ZSP-001 (Mandatory; Sources: D03, D06, D10, D13, D14, D17):** LocalHub MUST spend exactly USD `$0.00`. It MUST NOT purchase or renew anything; use a paid, metered, credit-consuming, quota-with-overage, trial-to-paid, hosted, or pay-as-you-go service; create a billing method or paid account; or make a donation, tip, bounty, or sponsorship payment.
- **LH-ZSP-002 (Mandatory; Sources: D13, D17):** The maintainer's already-active Apple Developer Program membership is the sole narrow exception while active. LocalHub MUST NOT purchase, renew, reimburse, or depend exclusively on it; the ad-hoc fallback remains mandatory.
- **LH-ZSP-003 (Mandatory; Sources: D13):** Current price and license eligibility MUST be verified from primary sources before each external dependency or action. Unknown, ambiguous, changed, or overage-capable pricing MUST block that action.
- **LH-TRU-001 (Mandatory; Sources: D06, D17):** Each macOS release MUST declare exactly one trust state and MUST verify its asset, exhaustive manifest, SHA-256 values, architecture, tree, and signatures before activation.
- **LH-TRU-002 (Conditional normal trust state; Source: D17):** While the existing membership path succeeds, the release wording MUST be: **Apple-notarized release** — “Signed with LocalHub's Apple Developer ID, notarized by Apple, and checksum verified. Notarization checks for known malware; it is not App Store review.”
- **LH-TRU-003 (Mandatory fallback trust state; Source: D17):** When membership or notarization is unavailable, the wording MUST be: **Unnotarized release** — “Checksum verified and ad-hoc signed, but not notarized or reviewed by Apple. macOS may block first launch. Use **System Settings → Privacy & Security → Open Anyway**. Never disable Gatekeeper.”
- **LH-TRU-004 (Mandatory; Source: D17):** LocalHub MUST NOT disable Gatekeeper, remove quarantine, automate a bypass, claim App Store review, or describe checksum/ad-hoc verification as Apple review.

### First Run Setup and reversible lifecycle

- **LH-LIF-001 (Mandatory; Sources: D12, D17):** First Run MUST follow: trust disclosure, Host Computer check, Model Storage, pinned llama.cpp verification, Member LAN readiness, optional Web Search, explicit **Start LocalHub**, then **Ready**.
- **LH-LIF-002 (Mandatory; Source: D12):** A stable route indicator and **What changes now** explanation MUST show the current local effect, protected state, and recovery path. The Host MAY quit before Start; only non-secret completed checks and confirmed choices MAY persist for resumption.
- **LH-LIF-003 (Mandatory; Source: D12):** Host checks MUST report Apple Silicon, supported macOS, free space, selected network interface, firewall/sleep risks, and exact results. A failed boundary MUST remain closed while unaffected Host control may continue.
- **LH-LIF-004 (Mandatory; Sources: D02, D12):** llama.cpp verification MUST name the pinned build, exact binary and architecture, loopback-only worker, Metal devices, load/health/stop result, and finite deadline. It MUST NOT auto-fit or silently change a profile, model, runtime, placement, or context.
- **LH-LIF-005 (Mandatory; Sources: D04, D12):** Member readiness MUST test only the selected private interface with a physical Member device. Firewall, mDNS, guest-isolation, or network failures MUST show a cause and recheck; the gateway MUST remain closed instead of rebinding silently.
- **LH-LIF-006 (Mandatory; Source: D12):** Ready MUST open the Host dashboard and state that Members still require an exact acquired, tested, and shared model before inference is available.
- **LH-LIF-007 (Mandatory; Sources: D06, D12, D13, D14):** Update review MUST identify the exact LocalHub, llama.cpp, Codex where applicable, SearXNG image/configuration, trust state, sizes, compatibility checks, active-work handling, state migration, and retained rollback pair before approval.
- **LH-LIF-008 (Mandatory; Sources: D06, D12, D13):** An update MUST verify manifest, signature, architecture, state compatibility, llama.cpp health, and optional SearXNG health before success. Any failure MUST atomically restore the immediately previous complete runtime/state and SearXNG image/configuration pair.
- **LH-LIF-009 (Mandatory; Sources: D06, D12):** Manual rollback MUST be explicit, show both complete component sets, leave models unchanged, and validate the restored Run.
- **LH-LIF-010 (Mandatory; Sources: D06, D12, D13):** Uninstall MUST run from stopped state and name the LocalHub runtime, launcher/agent, state/configuration, generated secret, and LocalHub-owned SearXNG resources to remove. Model Storage MUST be kept by default; moving managed models to Trash requires separate named confirmation. Docker, LM Studio, ordinary Codex, and outside source files MUST remain untouched.

### Exact model acquisition, profiles, and sharing

- **LH-MOD-001 (Mandatory; Source: D09):** Model Acquisition MUST begin only after the Host confirms one exact set of local files or one anonymous public HTTPS source currently verified to cost exactly `$0`. Final filenames, all required shards, and any optional companion MUST be shown and frozen before transfer.
- **LH-MOD-002 (Mandatory; Source: D09):** LocalHub MAY recommend an exact variant using visible size, quantization, architecture, and Host estimates, but MUST NOT choose a default quantization, first match, mirror, replacement shard, gated store, authenticated source, hidden search, or background download.
- **LH-MOD-003 (Mandatory; Source: D09):** A local file already inside Model Storage MAY be adopted after verification. A file outside it MUST be copied without changing the source. Remote content MUST stage on the destination volume under an opaque acquisition identity and MUST remain unloadable, untestable, and unshareable until verified and atomically promoted.
- **LH-MOD-004 (Mandatory; Source: D09):** Acquisition MUST preflight space and record exact sources, filenames, expected sizes and published digests when available, HTTP validators, received byte counts, and state. Interrupted content MUST be explicitly **Incomplete** and support only safe Resume or Discard.
- **LH-MOD-005 (Mandatory; Source: D09):** Resume MUST require byte-range support, the same validator, and the same total length. Changed or uncertain sources MUST be rejected; restart from byte zero requires Host confirmation. LocalHub MUST NOT concatenate uncertain bytes or switch sources.
- **LH-MOD-006 (Mandatory; Sources: D02, D09):** Verification MUST compute SHA-256 for each file and an ordered split manifest, compare supplied publisher digests, and parse GGUF offline for valid structure, complete shards, architecture, parameters, quantization, training context, templates, and companion identity. Filename, repository text, embedded metadata, and model names are hints, not capability proof.
- **LH-MOD-007 (Mandatory; Source: D09):** Digest mismatch, malformed GGUF, missing shard, wrong companion, unsupported architecture, or unreadable content MUST produce a precise failed acquisition and MUST NOT create an Installed Model. Identical verified content MUST reuse one content identity.
- **LH-MOD-008 (Mandatory; Source: D09):** Display names MUST be unique case-insensitively and MUST NOT define identity. Renames and verified moves preserve content identity. Missing or disconnected storage MUST mark the exact Installed/Shared Model unavailable until the same content is restored and verified.
- **LH-MOD-009 (Mandatory; Source: D09):** A storage move MUST wait until no affected request is queued, loading, or running and the worker is unloaded. Same-volume moves MUST be atomic. Cross-volume moves MUST stage, hash-verify, atomically switch the catalog, and only then remove the old managed copy. Failure leaves the old location canonical.
- **LH-MOD-010 (Mandatory; Source: D09):** Model removal MUST require unshare, unpin, and no active work; confirmation MUST name size, files, Run Profiles, and Profile Results. LocalHub MUST move only managed bytes to macOS Trash, remove dependent catalog evidence, and leave outside source files untouched.
- **LH-MOD-011 (Mandatory; Sources: D02, D09):** A Run Profile revision MUST bind exact model and companion hashes, pinned llama.cpp build, explicit chat template, and every load control. Editing any bound input creates a new untested revision and MUST NOT mutate prior results.
- **LH-MOD-012 (Mandatory; Sources: D02, D09):** A Profile Test MUST use the exact revision with automatic fitting disabled and prove clean load, health, model identity, per-slot Context Capacity, slot count, KV layout, placement, basic text response, cancellation, graceful stop, and observed resource/performance measurements on the Host Computer.
- **LH-MOD-013 (Mandatory; Source: D09):** A Profile Result MUST bind model/companion hashes, profile revision, llama.cpp binary, template, Host hardware/device inventory, and macOS version. Changes to any bound value make it **Stale**; renames and verified storage moves do not.
- **LH-MOD-014 (Mandatory baseline; conditional optional capabilities; Sources: D02, D09, D15):** Basic text generation MUST pass. Each optional Model Capability, including image input, structured Browser Tools, or Tool Runner functions, MUST be proven by a real exact-profile behavior test before exposure; otherwise it remains visibly unavailable.
- **LH-MOD-015 (Mandatory; Source: D09):** A Shared Model MUST be an explicit Host-published Member name bound to one exact, currently passing Run Profile revision, Member limits, and a subset of passed capabilities. Untested, failed, stale, or missing profiles MUST NOT accept new work.
- **LH-MOD-016 (Mandatory; Sources: D07, D09):** Explicit replacement affects only new requests. Already accepted requests MUST retain their immutable Shared Model, Model Variant, and Run Profile revision.
- **LH-MOD-017 (Mandatory; Sources: D02, D09):** No selected file, shard, quantization, projector, template, Model Variant, profile revision, context, runtime, capability, or source may be substituted. LocalHub MAY propose a different exact choice, but only the Host can accept and retest it.
- **LH-MOD-018 (Mandatory; Source: D02):** LocalHub MUST own the catalog, queue, gateway, and process supervision and run pinned loopback-only llama.cpp workers for exact Run Profile revisions. llama.cpp's built-in tools/agent surface MUST remain disabled.
- **LH-MOD-019 (Mandatory; Source: D02):** Exact runtime evidence MUST model context per slot together with slot count and unified/non-unified KV layout, verify effective model/build/template/capabilities after load, and distinguish projected from observed memory. Load-time changes require worker restart; Host-allowlisted sampling controls MAY vary per request without mutating the profile.
- **LH-MOD-020 (Conditional; Sources: D02, D09):** Multimodal behavior remains experimental and unavailable until exact live proof passes. Arbitrary document support MUST use bounded LocalHub extraction plus proven text/image input; it MUST NOT be inferred as a llama.cpp document capability.

### Host model control experience

- **LH-UIH-001 (Mandatory; Source: D08):** The Host dashboard MUST use the Evidence Ledger direction: a stable Inventory/Evidence/Operations sidebar and a searchable, dense ledger of exact Model Variants, Run Profile revisions, placement, current Profile Results, and observed measurements.
- **LH-UIH-002 (Mandatory; Source: D08):** The exact rendered launch command MUST remain visible with the selected profile. Estimates MUST remain visibly distinct from observed Profile Results.
- **LH-UIH-003 (Mandatory; Source: D08):** Compare, start/stop, pin, share, live-resource, and Request Queue controls MUST be first-class. Acquisition, downloads, storage, capabilities, files, and full evidence MAY use drill-downs without reducing ledger traceability.
- **LH-UIH-004 (Mandatory; Sources: D08, D12):** Warnings and failures MUST show cause, protected state, and explicit recovery actions; they MUST NOT hide a fallback.

### Member gateway, Browser Chat, privacy, and Attachments

- **LH-MEM-001 (Mandatory; Sources: D04, D11):** Browser Chat MUST enter through one small Member Link form for Member Label, exact Shared Model, and Conversation Memory. It MUST explain that LAN access grants inference only and that Member Label is neither an account nor verified identity.
- **LH-MEM-002 (Mandatory; Sources: D04, D11):** Browser Chat MUST use a quiet conversation-first layout. Desktop MUST provide a browser-local thread list, central chat, and transparency rail; phone MUST stack the same information below the conversation rather than become a technical console.
- **LH-MEM-003 (Mandatory; Sources: D04, D11):** The selected Shared Model, request state, queue position, streaming progress, connection recovery, cancellation, tool activity, limits, citations, and honest failures MUST remain visible.
- **LH-MEM-004 (Mandatory; Sources: D04, D10, D11):** History, Member-created documents, generated images, and research output MUST persist only in the Member's browser. The Host MUST NOT create a Member chat, Attachment, document, image, research, browser, or memory library.
- **LH-MEM-005 (Mandatory; Sources: D04, D07):** One same-origin SSE stream per anonymous browser session MUST multiplex request states, queue positions, token output, tool activity, completion, cancellation, and errors. Reconnect MUST use an event cursor and bounded replay without duplicate submission or transport-loss cancellation.
- **LH-MEM-006 (Mandatory; Sources: D07, D13):** Request recovery/output state MUST remain bounded and in memory until browser acknowledgement or five minutes after terminal state, whichever comes first, then be deleted. It is not Host-side history.
- **LH-MEM-007 (Mandatory; Source: D10):** One request MUST accept at most 10 Attachments, at most 10 MB each, and at most 24,000 extracted-text characters total. The Host MAY lower these limits but MUST NOT silently raise the v1 ceilings.
- **LH-MEM-008 (Mandatory; Sources: D10, D11):** Attachments MUST remain current-request-only. Accepted content MUST be read-only and deliberately included, never a Host path or adjacent file. Unsupported type, truncation, size, and count failures MUST be visible before inference; later use requires resend.
- **LH-MEM-009 (Mandatory; Sources: D04, D07, D10):** Host temporary copies MUST be deleted after completion, cancellation, validation failure, expiry, browser clear, or Run stop. Startup recovery MUST sweep abandoned temporary state before Member service resumes.
- **LH-MEM-010 (Mandatory; Sources: D07, D10, D13):** The Host queue/operations view MAY retain only operational metadata: request identity, Member Label, exact target, age, position, state, durations, byte counts, and failure classes. It MUST NOT expose prompts, responses, Attachment/page content, credentials, or generated output.
- **LH-MEM-011 (Mandatory; Sources: D10, D11):** Clearing a chat MUST remove its browser-local history/output and destroy its Browser Session without creating a Host-side copy.
- **LH-MEM-012 (Mandatory; Source: D13):** Persistent storage, logs, environment, temporary directories, and network boundaries MUST be inspected after success, failure, cancellation, disconnect, clear, stop, rollback, and uninstall. Credentials and Member content MUST not survive outside the accepted browser/recovery boundaries.
- **LH-MEM-013 (Mandatory; Source: D04):** Member service MUST describe its LAN HTTP boundary honestly and MUST NOT promise TLS, secure-context, or PWA behavior. Browser-owned history is origin-specific; changing Bonjour name, IP, port, or scheme MUST NOT silently merge browser histories.
- **LH-MEM-014 (Mandatory; Source: D04):** The Member gateway MUST enforce the selected subnet plus Host, Origin, CSRF, content-security, and sanitized-rendering boundaries. Model output containing HTML or LAN URLs MUST remain inert and MUST NOT trigger browser access to those destinations.

### Fair Request Queue

- **LH-QUE-001 (Mandatory; Source: D07):** LocalHub MUST use one deterministic, work-conserving Request Queue for all per-message Inference Requests. Scheduler events MUST serialize; simultaneous ties break by enqueue sequence, then stable request identity.
- **LH-QUE-002 (Mandatory; Source: D07):** Admission MUST assign an opaque request identity, immutable enqueue sequence, and exact Shared Model, Model Variant, and Run Profile revision. Impossible, unavailable, invalid-limit, unshared, or unproven-capability work MUST be rejected before queueing.
- **LH-QUE-003 (Mandatory; Source: D07):** At each scheduling opportunity, the globally oldest eligible request MUST anchor a snapshot of at most three already-waiting requests for that exact profile revision, in enqueue order. New arrivals MUST NOT join the snapshot.
- **LH-QUE-004 (Mandatory; Source: D07):** After at most three starts, scheduling MUST return to the globally oldest eligible request even if keeping the current profile loaded would reduce switching. Different profile revisions MUST NOT group merely because they use the same model.
- **LH-QUE-005 (Mandatory; Source: D07):** Free capacity for another already-loaded profile MAY serve its oldest eligible request concurrently only when that capacity cannot advance an older request. Only an idle, unpinned worker may unload; least-recently-used worker then stable worker identity breaks ties.
- **LH-QUE-006 (Mandatory; Source: D07):** Host-originated work enters ordinary FIFO by default. One waiting request MAY receive **Run next** from loopback Host control. One promotion may be pending; it cannot preempt, bypass a pin/check, or pull a same-profile group. At least one ordinary group MUST start between promotions.
- **LH-QUE-007 (Mandatory; Source: D07):** Browser Chat MUST show `Queued — N requests ahead`, the exact target, and queue-age countdown. Position means committed start order, not time. Ordinary later arrivals MUST NOT worsen it; a changed position MUST name cancellation, failure, promotion, or availability as the reason.
- **LH-QUE-008 (Mandatory; Source: D07):** Request states MUST be `queued`, `loading`, `running`, and `cancelling`, followed by exactly one terminal `completed`, `cancelled`, `expired`, or `failed` state with a plain-language reason.
- **LH-QUE-009 (Mandatory; Source: D07):** A Member session may cancel only its own work; the Host may cancel any work. Waiting cancellation MUST remove the request immediately. Running cancellation MUST free its live llama.cpp slot within 10 seconds or quarantine/restart the worker and explicitly fail affected active work.
- **LH-QUE-010 (Mandatory; Source: D07):** Transport loss MUST NOT cancel inference. Reconnect MUST resume through the session event cursor. Explicit cancellation, expiry, or failure MUST NOT automatically retry or resubmit.
- **LH-QUE-011 (Mandatory; Source: D07):** A Pinned Model MUST never unload or be replaced automatically. Impossible pinned-capacity work MUST reject immediately; a later pin that removes the last finite path MUST fail affected queued work immediately.
- **LH-QUE-012 (Mandatory; Source: D07):** A profile has at most 10 minutes to load, become healthy, and prove exact configuration. Failure MUST fail its current group and waiting exact-profile work, mark the revision unavailable, and advance unrelated work. Only an explicit Host retry or new passing Profile Test can restore eligibility.
- **LH-QUE-013 (Mandatory; Source: D07):** A request may wait at most 30 minutes from acceptance and run at most 30 minutes from dispatch. Expiry is terminal, visible, and never auto-resubmitted.

### Conditional public-web and Member Browser Tools

- **LH-WEB-001 (Mandatory disabled path; Sources: D10, D13, D14, D17):** Core LocalHub MUST remain usable with Web Search disabled. Absent, ineligible, unconfirmed, or unhealthy Docker Compose MUST NOT trigger an install, account, trial, hosted service, public instance, paid/key-based provider, or fallback.
- **LH-WEB-002 (Conditional enabled path; Sources: D14, D17):** First Run MAY enable Web Search only after finding working Host-supplied `docker compose` and displaying: **Enable Web Search?** “Web Search requires working `docker compose` supplied by you. LocalHub will not install Docker, create an account, start a trial, or purchase anything. Docker Desktop is free only for eligible personal, educational, non-commercial open-source, and qualifying small-business use. By continuing, you confirm your use is allowed at `$0` under the current Docker terms.”
- **LH-WEB-003 (Conditional enabled path; Source: D17):** The only choices MUST be **I confirm — Enable Web Search** and **Skip Web Search**. Missing or uncertain eligibility MUST leave Web Search disabled. The Apple membership exception MUST NOT extend to Docker.
- **LH-WEB-004 (Conditional enabled path; Source: D14):** LocalHub, llama.cpp, the Member gateway, and Host Tools MUST remain native macOS processes. Web Search MUST use the exact pinned, unmodified official SearXNG image in a separate Host-supplied Docker Compose environment.
- **LH-WEB-005 (Conditional enabled path; Sources: D03, D14):** Raw SearXNG MUST bind only to `127.0.0.1`; LocalHub is its sole product caller. Configuration MUST use a generated persistent secret, JSON API, finite health check, and no Host Docker-socket mount.
- **LH-WEB-006 (Conditional enabled path; Source: D14):** LocalHub MUST own the exact image tag/arm64 digest, Compose/configuration, secret lifecycle, enabled zero-cost/no-key engines, health, notices, and failure behavior. It MUST never use `latest`, independently auto-pull, or prune the prior image/configuration while it remains a rollback target.
- **LH-WEB-007 (Conditional enabled path; Source: D14):** Each new image pin MUST disclose compressed and clean-Mac installed sizes, check disk space, and pass search, security, zero-spend, compatibility, and license gates before Host approval.
- **LH-WEB-008 (Conditional enabled path; Sources: D03, D10):** Web Search, Web Fetch, and Web Research MUST use only the pinned SearXNG service plus LocalHub's guarded public-page fetch/citation boundary. There MUST be no public SearXNG, DuckDuckGo, Brave, Google PSE, Tavily, Serper, hosted, paid, metered, or key-based fallback.
- **LH-WEB-009 (Conditional enabled path; Source: D10):** Each public-web request MUST maintain a server-held registry of pages actually returned or fetched. Citation identifiers MUST resolve through that registry; missing or invented identifiers MUST be removed and visibly flagged. Every result MUST show Sources; a failed lookup MUST NOT be presented as current sourced information.
- **LH-WEB-010 (Conditional enabled path; Sources: D03, D10):** Search/page content MUST remain untrusted data, never a system/developer instruction, authority grant, or route to another Tool Group.
- **LH-WEB-011 (Conditional enabled path; Source: D10):** Web Search may fetch at most five pages, MUST finish within 30 seconds, and may contribute at most 10,000 tool-output characters to one model round.
- **LH-WEB-012 (Conditional enabled path; Source: D10):** Web Fetch MUST have a 10-second network/read budget and 30-second total budget. Default download is at most 2 MB; explicit full-page fetch may reach a 20 MB absolute ceiling. Parsed output is at most 10,000 characters and MUST identify partial output.
- **LH-WEB-013 (Conditional enabled path; Source: D10):** Web Research defaults to at most 12 searches, 15,000 extracted characters per page, 20 reasoning rounds, and five minutes active research, with a 30-minute absolute wall-clock deadline. Timeout MUST preserve partial cited findings only in the Member browser.
- **LH-WEB-014 (Conditional enabled path; Source: D10):** Other Member tool calls have a 60-second default deadline and remain inside the 30-minute Request run limit. The Host MAY lower, but MUST NOT silently raise, any v1 ceiling.
- **LH-WEB-015 (Mandatory authority boundary when any Browser Tool is offered; Source: D10):** Members MAY receive only Host-approved groups for Search/Fetch/Research, Documents and Attachments, local Image Generation, and Browser Automation whose exact Shared Model/Profile passed the necessary proof. Members MUST NOT receive Host shell, Python, Host files, secrets, MCP, runtime administration, private-LAN access, or generic Host APIs.
- **LH-WEB-016 (Mandatory authority boundary; Sources: D10, D11):** A Member MAY enable or disable offered Tool Groups per chat but MUST NOT add tools, widen inputs/limits, revive stale capabilities, or bypass Host policy.
- **LH-WEB-017 (Conditional Browser Automation; Source: D10):** Browser Automation MUST use one temporary LocalHub-owned Browser Session per Browser Chat and MUST NOT attach to or inherit the Host's normal browser profile, cookies, passwords, history, extensions, downloads, or sessions.
- **LH-WEB-018 (Conditional Browser Automation; Source: D10):** Browser Sessions MUST permit only public HTTP/HTTPS. They MUST reject all other schemes and loopback, private, link-local, shared, multicast, reserved, unspecified, or otherwise non-public addresses before connection and after every DNS resolution and redirect.
- **LH-WEB-019 (Conditional Browser Automation; Sources: D10, D11):** Sign-in, submit, send, post, upload, download, delete, or any external change MUST pause immediately beforehand and display the site, exact action, and submitted data. Approval is one-time. Denied or uncertain external changes MUST NOT retry automatically.
- **LH-WEB-020 (Mandatory zero-spend denial; Source: D10):** Purchase, checkout, subscription, donation, paid API, metered endpoint, trial-to-paid, or other spend-capable actions MUST be denied before execution with no Member or Host override.
- **LH-WEB-021 (Mandatory Browser Tool observability; Sources: D10, D11):** Browser Chat MUST show tool name, requested action, start, live progress/elapsed time, approval, completion, sources, truncation, cancellation, and exact failure. Cancellation MUST stop disposable tool/browser work within 10 seconds or terminate it and fail the request visibly.
- **LH-WEB-022 (Conditional enabled path; Source: D14):** About/legal evidence MUST identify the exact SearXNG image and link its AGPL-3.0-or-later license and Corresponding Source. LocalHub remains MIT and MUST NOT copy SearXNG code or distribute/mirror image bytes without a new focused distribution/license review.
- **LH-WEB-023 (Conditional enabled path; Source: D14):** The first public Web Search release and each changed distribution boundary MUST pass a focused current license/notices/source review. This is a release gate and conservative engineering boundary, not legal advice.
- **LH-WEB-024 (Conditional enabled path; Sources: D03, D10):** Queries, results, fetched page content, and research content MUST remain in memory only for active/bounded processing, be excluded from ordinary logs and Host content views, and clear on terminal cleanup/Run stop. Operational counters MAY retain only non-content engine, status, duration, size, and failure metadata.

### Host Tool authority and Evidence Ledger

- **LH-HST-001 (Mandatory; Sources: D10, D18):** Host Tools MUST exist only on loopback Host control, begin globally disabled, and never appear, link, advertise schemas, or accept calls through Member Browser Chat or the Member gateway.
- **LH-HST-002 (Mandatory; Source: D18):** First enablement MUST require a compact **Nothing here is a sandbox** acknowledgement explaining destructive model proposals, prompt-injection risk, Member exclusion, and non-approvable money actions.
- **LH-HST-003 (Mandatory; Sources: D10, D18):** Host Tools MUST be described as unsandboxed and run with the LocalHub process's operating-system and network permissions. The dashboard MUST display exact executable, OS user, process identity, listener, selected roots, and effective authority.
- **LH-HST-004 (Mandatory; Source: D18):** Material process identity or authority-scope change MUST require the acknowledgement again.
- **LH-HST-005 (Mandatory; Source: D18):** After global enablement, the Host MUST have Tool Group and per-tool switches. V1 groups are Local Execution, Workspace, Integrations, and Browser; entry points are Shell, Python, Host Files, MCP, and Host Browser.
- **LH-HST-006 (Mandatory; Sources: D10, D18):** Disabled Host Tools MUST NOT be advertised or callable. Selecting an enabled tool MUST retain visible authority and live-resource evidence rather than hiding it behind chat alone.
- **LH-HST-007 (Mandatory; Source: D18):** Every Host Tool run MUST record exact input, process/integration identity, start, live progress and elapsed time, streamed output, pending approval, completion, cancellation, cleanup, failure reason, and explicit retry.
- **LH-HST-008 (Mandatory; Sources: D10, D18):** External changes MUST pause immediately beforehand for one-time approval. Uncertain external changes MUST NOT retry automatically. Spend-capable actions MUST create a denial evidence event with no approval/override path.
- **LH-HST-009 (Mandatory; Sources: D08, D18):** Host Tool authority, runs, and recent authority events MUST extend the accepted Evidence Ledger using the chosen Authority Ledger structure and navy/cyan/serif/monospaced evidence direction. Observed events MUST remain visually distinct from estimates, warnings, and proposals.

### Isolated local Codex Tool Runner

- **LH-COD-001 (Mandatory; Sources: D15, D16, D19):** `lh codex` MUST be an isolated caller-local Tool Runner, not an alternate entrance to ordinary Codex. The Host supplies inference only; local functions execute on the caller's computer under its pinned sandbox and approvals.
- **LH-COD-002 (Mandatory; Sources: D15, D16):** The shipped Tool Runner MUST use Codex `0.145.0` complete packages on macOS Apple arm64, native Windows 11 x64, and Ubuntu 24.04 under WSL2. Client/Host version skew MUST block with the exact required release.
- **LH-COD-003 (Mandatory; Source: D16):** Discovery MUST try the Host-provided friendly name first, show it and the current private IP, and offer only that IP fallback. It MUST NOT scan or guess the LAN.
- **LH-COD-004 (Mandatory; Sources: D16, D19):** Launch MUST require one explicit local working directory and one currently passing real Tool Runner Shared Model/Profile. With no passing profile, `lh codex` is unavailable; there is no chat-only, hosted, reduced, or alternate-model fallback labeled Codex-capable.
- **LH-COD-005 (Mandatory; Sources: D15, D19):** Each launch MUST create a disposable child-only `CODEX_HOME`, scrub inherited `CODEX_*`, send no ordinary Codex/OpenAI credential, and leave normal configuration, authentication, history, provider, and workspaces outside the selected root unchanged.
- **LH-COD-006 (Mandatory; Sources: D15, D19):** Plugins, remote plugins, skills, agents/multi-agent namespaces, MCP, hosted search, unified exec, image-history services, ordinary sessions, and Responses WebSockets MUST remain absent. Transport is HTTP/SSE. Host llama.cpp MUST start with no tools or agent surface.
- **LH-COD-007 (Mandatory baseline; conditional image function; Sources: D15, D19):** `request_user_input`, `shell_command`, and `update_plan` MUST be advertised only after real exact-profile function-call round trips pass. `view_image` MUST be advertised only after the same profile also passes image-input and tool-result proof.
- **LH-COD-008 (Mandatory; Sources: D16, D19):** Pre-launch MUST state that tools execute locally; the Host receives prompts, selected excerpts, tool schemas, and results needed for inference; approved changes in the chosen workspace persist; and ordinary Codex state and credentials are neither loaded nor changed.
- **LH-COD-009 (Mandatory; Sources: D15, D16):** Queue waiting MUST show exact profile, honest position, and five-second keepalive. Reconnect MUST resume from the request cursor when possible without duplicate submission or model change. Cancellation, context failure, version skew, Host loss, and cleanup failure MUST remain explicit.
- **LH-COD-010 (Mandatory; Sources: D15, D16, D19):** The local sandbox and approvals MUST remain authoritative. Approved changes within the selected workspace persist; denied and outside-workspace effects MUST not execute.
- **LH-COD-011 (Mandatory; Sources: D15, D16, D19):** Native Windows MAY require the proven one-time elevated sandbox setup, but `lh codex` and Codex MUST not run elevated afterward. Refusal/failure blocks launch without unsandboxed fallback. WSL2 MUST use the complete Linux package and bundled `bwrap`; missing/failing prerequisites block launch. WSL2 does not imply general Linux support.
- **LH-COD-012 (Mandatory; Sources: D16, D19):** Normal exit and recovery MUST remove the disposable child home, report ordinary Codex state untouched, and preserve only approved workspace changes.
- **LH-COD-013 (Mandatory; Source: D19):** Pre-launch MUST use one compact isolation notice. A diagnostic command MUST expose the complete technical inventory of disabled/available surfaces, sandbox prerequisites, selected Host/profile, and isolation state without turning onboarding into a warning wall.

### Migration from the current LM Studio-backed application

- **LH-MIG-001 (Mandatory; Source: D13):** Migration MUST detect the existing LM Studio-backed `lh` installation and save an exact backup of its installed binary and non-secret configuration before replacement.
- **LH-MIG-002 (Mandatory; Source: D13):** Migration MUST show legacy context length, configured local/LAN endpoint values, token-environment variable name, and selected-model value as reference only. It MUST import nothing silently and MUST never read, copy, persist, display, or forward the token value.
- **LH-MIG-003 (Mandatory; Sources: D01, D13):** Legacy LM Studio runtime assumptions, routes, model keys, and auto-expanded context behavior MUST NOT become v1 Run Profiles or architecture by inference. The Host must create and test explicit v1 choices.
- **LH-MIG-004 (Mandatory; Source: D13):** LM Studio, LM Studio-managed model files, LM Studio credentials, server settings, LM Link state, and ordinary Codex state MUST remain untouched.
- **LH-MIG-005 (Mandatory; Sources: D09, D13):** A compatible local GGUF MAY enter v1 only through normal Host-confirmed Model Acquisition and verification. No MLX/GGUF file may be adopted merely because the legacy app or LM Studio named it.
- **LH-MIG-006 (Mandatory; Source: D13):** Cutover MUST occur only after the new LocalHub Run passes health and the Host explicitly confirms replacement. A failed cutover MUST restore the prior binary and non-secret configuration.
- **LH-MIG-007 (Mandatory; Sources: D06, D13):** The migration backup MUST remain a named recovery target until the Host accepts the new Run. Restoration MUST NOT change LM Studio, its models, tokens, or ordinary Codex state.
- **LH-MIG-008 (Mandatory; Source: D13):** Migration, update, and recovery MUST prove there is no silent model, profile, context, provider, runtime, route, or data substitution.

## Testing Decisions

### What makes a good test

- **LH-TST-001 (Mandatory; Source: D13):** Tests MUST assert externally observable behavior, authority, persistence, network/process state, and evidence. Internal call order, private data shapes, source layout, and UI snapshots alone are not acceptance.
- **LH-TST-002 (Mandatory; Source: D13):** Repeatable automated checks SHOULD run first, followed by the real journey on live supported hardware. UI gates require the running assembled app; type checks, unit tests, mocks, planning prototypes, and source-checkout runs MUST NOT substitute for release evidence.
- **LH-TST-003 (Mandatory; Source: D13):** Failure and recovery claims MUST use deliberate fault injection. Security, privacy, authority, and no-substitution claims MUST include negative or adversarial attempts.
- **LH-TST-004 (Mandatory; Source: D13):** Every gate MUST record exactly one of **Passed**, **Failed**, **Blocked**, or **Not applicable**. Blocked, unrun, missing, stale, flaky-only, or ambiguous evidence is not a pass. **Not applicable** is allowed only for a conditional capability that is not advertised/enabled, after its disabled behavior passes.
- **LH-TST-005 (Mandatory; Source: D13):** Failed attempts MUST remain visible with the corrective change and successful rerun. Skipped/flaky gates MUST not be hidden.

### Confirmed highest practical test seams

1. **LH-SEAM-001 — Canonical assembled-release seam (authoritative).** Launch the assembled candidate as a user would and drive only the shipped `lh` commands, loopback Host experience, Member Link/Browser Chat, and shipped `lh codex` Tool Runner. Observe public responses plus real process, listener, filesystem, temporary-state, environment, network, resource, and cleanup effects. All J1–J8 release verdicts and the exact live matrix belong to this seam. The evidence MUST identify the release asset rather than a source checkout.
2. **LH-SEAM-002 — Controlled external-dependency seam (supporting).** Drive those same product entrances while controlling only external process/protocol conditions: llama.cpp/Responses behavior, SearXNG/public pages, Docker Compose availability, DNS/redirects, network interruption, clock/deadlines, storage/filesystem failures, and process exits. This seam makes scheduling, timeouts, recovery, rollback, security, privacy, and no-substitution cases deterministic. Its result supports CI and fault diagnosis but MUST NOT replace the assembled candidate's required live runtime, model, browser, hardware, trust, or sandbox evidence.

No separate internal module, database, reducer, DOM snapshot, or prototype seam is authoritative. Implementations MAY add narrow lower-level tests for fast feedback, but those tests cannot weaken or replace `LH-SEAM-001`.

### Prior art to preserve without freezing the target architecture

- The current application already drives its exported command behavior with injected process, configuration, network, and interactive dependencies; this is good prior art for deterministic boundary tests.
- Current runtime tests use controlled external API responses for load, cancellation, timeout, malformed data, routing, and fail-closed behavior; v1 should retain that external-contract style while replacing LM Studio assumptions.
- Current renderer tests exercise user-visible state and keyboard behavior rather than pixel snapshots; production web accessibility requires a higher running-browser seam.
- The Codex compatibility research launches the real pinned Codex package against a deterministic Responses server, inspects advertised functions and credentials, and verifies filesystem/sandbox effects on macOS, native Windows, and WSL2. This is direct prior art for `LH-SEAM-002`; its real-model gaps remain `LH-SEAM-001` gates.

### Release evidence schema

- **LH-EVD-001 (Mandatory; Source: D13):** Evidence MUST bind the exact LocalHub commit/tag, release asset, exhaustive manifest and checksums, architecture, declared trust state, dependency pins/digests, state schema, and rollback target.
- **LH-EVD-002 (Mandatory; Source: D13):** Evidence MUST record Host and Tool Runner hardware, exact OS/browser versions, network lane, Model Variant and companion hashes, chat template, Run Profile revision, effective settings, and test date.
- **LH-EVD-003 (Mandatory; Source: D13):** Each gate record MUST include its stable journey gate ID, requirement IDs, classification, status, sanitized action/command, expected result, observed result, evidence artifact links, tester, timestamp, and any prior failed attempt/correction.
- **LH-EVD-004 (Mandatory; Source: D13):** Evidence artifacts MAY use sanitized commands, logs, screenshots, or short recordings. They MUST contain no credentials, prompts, responses, Attachment contents, private documents, generated private output, private hostnames, or public IP addresses.
- **LH-EVD-005 (Mandatory; Source: D13):** A prior research, prototype, fake-provider, source-checkout, or older-candidate result is context only. A material runtime, model, profile, template, platform, release asset, or trust-state change invalidates the affected gate.
- **LH-EVD-006 (Mandatory; Source: D13):** Every release result MUST be reproducible from the published asset. An untested platform/browser lane MUST be declared unsupported; broad “modern browser” or “Apple-silicon compatible” claims are forbidden.
- **LH-EVD-007 (Mandatory; Source: D13):** No universal answer-quality or tokens-per-second threshold is invented. Evidence MUST record load time, first-token time, throughput, peak RAM/GPU use, queue time, and tool duration for the exact environment; accepted safety and deadline limits remain pass/fail.

### Exact live platform and evidence matrix

| Lane ID | Classification | Exact minimum lane | Required evidence |
| --- | --- | --- | --- |
| **LH-MTX-HOST-01** | Mandatory | One clean physical Apple-silicon Mac Host on the release-declared supported macOS version | Install/trust, manifest, runtime, Host UI, LAN listeners, real models, resources, failures, rollback, uninstall |
| **LH-MTX-BROWSER-01** | Mandatory | Physical iPhone Safari on the same trusted LAN | Member Link/QR, Browser Chat, streaming/reconnect, Attachments, phone layout, browser-local ownership, VoiceOver |
| **LH-MTX-BROWSER-02** | Mandatory | Mac Safari on the same trusted LAN | Browser Chat and full claimed Member capability set |
| **LH-MTX-BROWSER-03** | Mandatory | Mac Chrome on the same trusted LAN | Browser Chat and full claimed Member capability set |
| **LH-MTX-BROWSER-04** | Mandatory | Windows Edge on the same trusted LAN | Browser Chat and full claimed Member capability set, keyboard/reflow, NVDA where used |
| **LH-MTX-BROWSER-05** | Mandatory | Windows Chrome on the same trusted LAN | Browser Chat and full claimed Member capability set |
| **LH-MTX-CODEX-01** | Mandatory | Complete Tool Runner package on macOS Apple arm64 | Real passing Codex profile/functions, sandbox, isolation, queue/recovery, cleanup |
| **LH-MTX-CODEX-02** | Mandatory | Complete Tool Runner package on native Windows 11 x64 | One-time sandbox setup plus the complete Tool Runner journey |
| **LH-MTX-CODEX-03** | Mandatory | Complete Tool Runner package on Ubuntu 24.04 under WSL2 | Complete Linux package, bundled `bwrap`, Linux workspace, complete Tool Runner journey |

### Mandatory and conditional capability matrix

| Capability | Classification | v1 release rule |
| --- | --- | --- |
| Install, First Run, Run lifecycle, migration, update/rollback, uninstall | Mandatory | All gates pass on the exact candidate |
| Exact model acquisition, text Profile Test, and at least one text Shared Model | Mandatory | At least one real text Shared Model passes all applicable journeys |
| Member Browser Chat, fair queue, browser ownership, Attachment boundary | Mandatory | All exact browser lanes pass |
| Host Tools | Mandatory | Disabled-by-default, enablement, controls, authority denial, and evidence pass |
| Codex Tool Runner | Mandatory | At least one exact real Codex-capable Shared Model/Profile and all three platform packages pass |
| Web Search/Fetch/Research and SearXNG | Conditional | Disabled behavior always passes; all J5 gates block advertising/enabling |
| Browser Automation | Conditional | Unavailable unless exact profile and isolated Browser Session gates pass |
| Optional model image/document/tool capabilities | Conditional | Omitted unless exact profile proof passes |
| `view_image` in Tool Runner | Conditional | Omitted unless the same exact profile passes image and tool-result proof |
| Apple-notarized release state | Conditional on existing membership success | Exact normal wording and evidence pass when shipped; ad-hoc fallback remains available |

### Eight mandatory journey suites

All eight suites are mandatory. Within J5, disabled behavior is mandatory and enabled capability gates are conditional until advertised. The exact expected results below are the release contract.

#### J1 — Clean Host install, First Run, Run lifecycle

Starting from a clean supported macOS user state:

1. **LH-J1-001 (Requirements: LH-GOV-011, LH-PIN-005, LH-TRU-001–004):** Verify the exact release asset, exhaustive manifest, architecture, checksum, signature, and declared Apple-notarized or unnotarized trust state.
2. **LH-J1-002 (Requirements: LH-LIF-001–006):** Complete the Guided Runway: Host checks, Model Storage, pinned llama.cpp verification, selected private interface, Member Link/QR readiness, and explicit **Start LocalHub**.
3. **LH-J1-003 (Requirements: LH-GOV-003–004, LH-GOV-012, LH-LIF-005):** Prove Host control stays loopback-only, the Member gateway binds only to the selected private interface, and a physical Member device opens the exact friendly link with the displayed private-IP fallback, including verified rebind after an interface/address change.
4. **LH-J1-004 (Requirements: LH-GOV-007–008):** Close setup UI/browser/terminal and prove the LocalHub Run remains active; use **Stop LocalHub** and prove new work is rejected, active work resolves explicitly, the Member Link closes, and LocalHub-owned services stop.
5. **LH-J1-005 (Requirements: LH-GOV-009, LH-LIF-003–005):** Force corrupt manifest, wrong architecture, failed llama.cpp health, unavailable storage, mDNS, interface, and firewall cases. Each MUST fail closed with the real cause, protected state, one repair path, and explicit recheck.
6. **LH-J1-006 (Requirements: LH-TRU-002–004):** Prove each shipped trust state: normal Apple-notarized wording while the existing membership path succeeds, and the checksum-verified ad-hoc/Open Anyway fallback without disabling Gatekeeper or stripping quarantine.

Sources: D06, D12, D17.

#### J2 — Exact model acquisition through Shared Model

Using real model bytes and the pinned runtime:

1. **LH-J2-001 (Requirements: LH-MOD-001–005):** Complete one local-file acquisition and one exact public zero-cost HTTPS acquisition, including interrupted/resumed transfer and changed-source rejection.
2. **LH-J2-002 (Requirements: LH-MOD-006–007):** Verify file/shard completeness, SHA-256/content manifest, GGUF structure, architecture, metadata, optional companion identity, and atomic promotion. Incomplete or failed bytes MUST never be loadable.
3. **LH-J2-003 (Requirements: LH-MOD-008–010):** Prove rename preserves identity; same-volume and cross-volume moves preserve verified identity; disconnected storage makes the exact model unavailable; deletion touches only confirmed managed content.
4. **LH-J2-004 (Requirements: LH-MOD-011–013, LH-MOD-018–019):** Create and run an exact Run Profile with automatic fitting disabled. Record effective context, placement, slot/KV settings, load/stop behavior, cancellation, peak memory/GPU use, load time, first-token time, throughput, and other Profile Results; prove the loopback worker exposes no built-in tools.
5. **LH-J2-005 (Requirements: LH-MOD-011, LH-MOD-013, LH-MOD-015):** Edit a profile-bound input and prove the prior result becomes stale. A failed or stale profile MUST NOT be published.
6. **LH-J2-006 (Requirements: LH-MOD-015–016, LH-QUE-011):** Publish one exact passing text Shared Model, then exercise pin/unpin, share/unshare, and explicit replacement without changing already accepted requests.
7. **LH-J2-007 (Requirements: LH-MOD-014–015, LH-MOD-020):** Prove every advertised optional Model Capability with the exact model/profile/template/runtime or keep it visibly unavailable. Metadata and names never count as proof.
8. **LH-J2-008 (Requirements: LH-MOD-017):** Attempt missing, incompatible, stale, renamed, and similarly named substitutes; every attempt MUST fail visibly rather than select another file, model, profile, template, runtime, context, or capability.

At least one real text Shared Model MUST pass the applicable v1 journeys. Sources: D08, D09.

#### J3 — Member Link, Browser Chat, Attachments, and browser ownership

On every claimed browser lane:

1. **LH-J3-001 (Requirements: LH-MEM-001–003):** Enter through Member Link/QR, choose a Member Label, exact Shared Model, and Conversation Memory, and verify the label is neither an account nor an access check.
2. **LH-J3-002 (Requirements: LH-MEM-004–006, LH-MEM-013):** Stream a real response; refresh/reopen the browser and prove history and Member-created output remain browser-local while the Host retains no chat history. Prove origin changes do not silently merge browser histories.
3. **LH-J3-003 (Requirements: LH-GOV-010, LH-MEM-002):** Exercise Quiet Conversation at phone and desktop widths, keyboard-only use, zoom/reflow, visible focus, contrast, and screen-reader labels. Host and Member surfaces MUST target WCAG 2.2 AA with automated checks plus live VoiceOver/NVDA checks.
4. **LH-J3-004 (Requirements: LH-MEM-007–008):** Submit accepted, unsupported, oversized, truncated, and over-count Attachments. A request MUST receive only deliberately included content, never a Host path or adjacent files.
5. **LH-J3-005 (Requirements: LH-MEM-008–009):** Prove current-request-only handling, visible limits, terminal cleanup, resend for later use, and cleanup after browser clear and LocalHub stop.
6. **LH-J3-006 (Requirements: LH-MEM-010, LH-MEM-012, LH-MEM-014):** Verify Host operations exposes only operational metadata and Member Label, never prompt, response, Attachment, page, credential, or generated-output content; verify cross-origin and rendered-content attempts do not widen access.
7. **LH-J3-007 (Requirements: LH-MEM-011):** Clear chat and prove browser history/output and Browser Session disappear as declared, without creating a Host-side library.

Sources: D04, D10, D11, D13.

#### J4 — Fair scheduling, recovery, cancellation, and finite work

Using concurrent real clients and live llama.cpp workers:

1. **LH-J4-001 (Requirements: LH-QUE-001–005):** Prove **A1, B1, A2, A3, A4** starts as **A1, A2, A3, B1, A4**.
2. **LH-J4-002 (Requirements: LH-QUE-003–004):** Prove continuous same-profile arrivals cannot strand another profile; new arrivals cannot join an already snapshotted group.
3. **LH-J4-003 (Requirements: LH-QUE-006):** Prove repeated Host **Run next** actions alternate with ordinary groups, never preempt active work, bypass a pin, or pull a same-profile group.
4. **LH-J4-004 (Requirements: LH-QUE-007–008):** Verify honest committed start positions and visible reasons when cancellation, failure, promotion, or availability changes them.
5. **LH-J4-005 (Requirements: LH-QUE-002, LH-QUE-011):** Reject impossible pinned-capacity work immediately and fail queued work if a later pin removes its last finite path.
6. **LH-J4-006 (Requirements: LH-QUE-012):** Force profile load failure and prove affected exact-profile work fails while unrelated work advances.
7. **LH-J4-007 (Requirements: LH-MEM-005–006, LH-QUE-010):** Disconnect/reconnect a phone using the event cursor; inference MUST neither cancel nor duplicate. Expired recovery state and temporary output MUST be deleted.
8. **LH-J4-008 (Requirements: LH-QUE-009):** Cancel waiting and running work. Running cancellation MUST free the live llama.cpp slot within 10 seconds or quarantine/restart the worker and explicitly fail affected work.
9. **LH-J4-009 (Requirements: LH-QUE-008, LH-QUE-012–013):** Prove the 10-minute profile load/health limit, 30-minute maximum wait, 30-minute maximum run, and exactly one terminal state for every request.

Source: D07.

#### J5 — Conditional public-web and Browser Tool capability

Disabled behavior is mandatory. Enabled behavior is release-blocking before the capability may be advertised.

1. **LH-J5-001 (Requirements: LH-WEB-001–003):** With Docker absent, ineligible, unconfirmed, or unhealthy, prove LocalHub remains usable and Web Search stays disabled with no account, trial, install, hosted service, public instance, paid API, key-based provider, or automatic fallback.
2. **LH-J5-002 (Requirements: LH-WEB-002–007, LH-WEB-022–023):** When enabled, confirm Host-supplied `docker compose`, exact current zero-cost wording, exact pinned arm64 SearXNG tag/digest and size, generated secret, loopback-only bind, finite health, restart, stop, no orphan container, and current license/notices/source review.
3. **LH-J5-003 (Requirements: LH-WEB-008–014, LH-WEB-024):** Run real Search, Fetch, and Research. Verify registry-backed citations, missing/invented citation rejection, partial-result labeling, exact time/size/output limits, transient content handling, and no provider substitution.
4. **LH-J5-004 (Requirements: LH-MEM-014, LH-WEB-010, LH-WEB-018):** Attack public-page isolation with loopback, private/link-local/reserved addresses, alternate schemes, DNS rebinding, redirects, oversized content, unsupported types, prompt injection, and SearXNG outage. Authority MUST not widen.
5. **LH-J5-005 (Requirements: LH-WEB-017–018):** Run Browser Automation in a one-chat temporary Browser Session. Prove it never inherits Host browser profile, cookies, secrets, extensions, downloads, or private-LAN access.
6. **LH-J5-006 (Requirements: LH-WEB-019):** Pause immediately before each external change; show site, action, and submitted data; require one-time approval; never automatically retry an uncertain external change.
7. **LH-J5-007 (Requirements: LH-WEB-020):** Attempt purchase, checkout, donation, subscription, paid API, metered endpoint, and trial-to-paid actions. Every path MUST be denied with no approval override.
8. **LH-J5-008 (Requirements: LH-WEB-021):** Exercise cancellation, timeout, tool/model capability mismatch, cleanup failure, and browser clear/Run stop. All temporary state MUST terminate or fail visibly inside accepted deadlines.

Sources: D03, D10, D14, D17.

#### J6 — Host Tool authority and evidence

On the loopback-only Host surface:

1. **LH-J6-001 (Requirements: LH-HST-001–002):** Prove Host Tools begin globally disabled and first enablement requires the exact machine-level **Nothing here is a sandbox** acknowledgement.
2. **LH-J6-002 (Requirements: LH-HST-003–004):** Show exact executable, operating-system user, process identity, listener, selected roots, and effective authority; materially changing identity/scope MUST require acknowledgement again.
3. **LH-J6-003 (Requirements: LH-HST-005–006):** Exercise Tool Group and per-tool control for Shell, Python, Host Files, MCP, and Host Browser. Disabled tools MUST NOT be advertised or callable.
4. **LH-J6-004 (Requirements: LH-HST-001):** From Member Browser Chat and the Member gateway, attempt every Host Tool/admin route and verify denial with no link, schema, or execution leakage.
5. **LH-J6-005 (Requirements: LH-HST-007):** For enabled Host Tools, capture exact input, process/integration identity, progress, output, approval, cancellation, cleanup, failure, and explicit retry.
6. **LH-J6-006 (Requirements: LH-HST-008):** Pause before external changes, never retry uncertain changes automatically, and deny every spend-capable action without override.
7. **LH-J6-007 (Requirements: LH-HST-009):** Prove the Evidence Ledger remains honest: observed results and authority events are distinct from estimates, warnings, and proposed actions.

Sources: D10, D18.

#### J7 — Isolated local Codex Tool Runner

Run the complete pinned packages on macOS Apple arm64, native Windows 11 x64, and Ubuntu 24.04 under WSL2:

1. **LH-J7-001 (Requirements: LH-COD-002–004):** Install or invoke the exact package, discover only the Host-provided friendly name or displayed private IP, choose an explicit local working directory, and select only a currently passing real Tool Runner Shared Model/Profile.
2. **LH-J7-002 (Requirements: LH-COD-007):** Prove real function-call round trips for `request_user_input`, `shell_command`, and `update_plan`; expose `view_image` only after the same exact profile also passes image proof.
3. **LH-J7-003 (Requirements: LH-COD-004, LH-MOD-014):** Require at least one real Codex-capable Shared Model/Profile before v1 acceptance. The compatibility research has no passing real profile; this remains an implementation/release gate.
4. **LH-J7-004 (Requirements: LH-COD-005):** Create a disposable child-only `CODEX_HOME`, scrub inherited `CODEX_*`, send no ordinary Codex/OpenAI credential, and leave normal configuration, authentication, history, provider, and workspaces outside the selected root unchanged.
5. **LH-J7-005 (Requirements: LH-COD-006, LH-COD-013):** Prove plugins, remote plugins, skills, agents, MCP, hosted search, unified exec, ordinary sessions, and Responses WebSockets are absent; Host llama.cpp exposes no tools; diagnostics report the exact isolated surface.
6. **LH-J7-006 (Requirements: LH-COD-010):** Approve a change inside the selected workspace and prove it persists. Deny and attempt outside-workspace effects and prove the sandbox blocks them.
7. **LH-J7-007 (Requirements: LH-COD-009, LH-COD-012):** Exercise real queue wait/keepalive, reconnect without duplicate submission, cancellation, context failure, version skew, no passing profile, Host loss, and disposable-child cleanup.
8. **LH-J7-008 (Requirements: LH-COD-011):** Prove native Windows one-time elevated sandbox setup and WSL2 `bwrap`. Refusal, absence, or failure MUST block launch with no standalone-binary, elevated-runtime, unsandboxed, chat-only, or hosted fallback.

Sources: D05, D15, D16, D19.

#### J8 — Legacy migration, forced recovery, update/rollback, and uninstall

1. **LH-J8-001 (Requirements: LH-MIG-001):** Detect the current LM Studio-backed `lh` installation and save an exact backup of its binary and non-secret configuration before replacement.
2. **LH-J8-002 (Requirements: LH-MIG-002–003):** Show legacy context, endpoint, token-environment-name, and selected-model values as reference only. Import nothing silently; never copy a token.
3. **LH-J8-003 (Requirements: LH-MIG-004–005):** Leave LM Studio, LM Studio-managed models, credentials, server settings, and ordinary Codex state untouched. A compatible local GGUF enters only through normal verified Model Acquisition.
4. **LH-J8-004 (Requirements: LH-MIG-006–007):** Cut over only after the new LocalHub Run passes health and the Host explicitly confirms. A failed cutover MUST restore the prior binary/configuration.
5. **LH-J8-005 (Requirements: LH-LIF-007–009):** Perform explicit update review, stop active work honestly, and force manifest, activation, state migration, llama.cpp health, and optional SearXNG health failures. Each MUST atomically restore the immediately previous complete runtime/state and SearXNG image/configuration pair.
6. **LH-J8-006 (Requirements: LH-GOV-009, LH-MIG-008):** Prove manual rollback, interrupted update recovery, worker crash recovery, unavailable storage, gateway restart, and cleanup without silent data/model/runtime substitution.
7. **LH-J8-007 (Requirements: LH-LIF-010):** Uninstall from stopped state. Remove only named LocalHub runtime, launcher/agent, state/configuration, generated secret, and LocalHub-owned SearXNG resources. Keep Model Storage by default; moving managed models to Trash requires separate confirmation. Never remove Docker, LM Studio, ordinary Codex, or outside source files.

Sources: D06, D12, D13.

### Cross-cutting release verdict

- **LH-ACC-001 (Mandatory; Source: D13):** A candidate is accepted only when every mandatory journey gate passes on the exact candidate and every advertised conditional capability passes its enabled gates.
- **LH-ACC-002 (Mandatory; Sources: D03, D10, D13, D14, D17):** Zero-spend proof MUST show no LocalHub-funded purchase, renewal, account, billing method, credit, meter, overage, donation, trial, or provider fallback. The narrow existing Apple membership and exact Docker eligibility rules remain unchanged.
- **LH-ACC-003 (Mandatory; Sources: D04, D10, D13):** Privacy proof MUST cover persistence, logs, environment, temporary directories, browsers, network egress, success, failure, cancellation, disconnect, clear, stop, rollback, and uninstall.
- **LH-ACC-004 (Mandatory; Sources: D07, D09, D10, D13, D15):** No-substitution proof MUST attempt unavailable models, profiles, runtimes, providers, capabilities, routes, trust states, sandboxes, and dependencies and observe explicit unavailability/failure.
- **LH-ACC-005 (Mandatory; Sources: D08, D11, D13, D18):** Accessibility proof MUST combine automated checks with live keyboard, zoom/reflow, visible-focus, contrast, VoiceOver, NVDA, phone, and desktop evidence for WCAG 2.2 AA.
- **LH-ACC-006 (Mandatory; Source: D13):** Candidate integrity requires every result to reproduce from the release artifact. Research, prototypes, source checkouts, CI-only runs, and mocks are not shipped-asset evidence.

## Out of Scope

The following are later work and MUST NOT block v1 or enter implementation implicitly:

- **LH-LATER-001:** Public or remote access, accounts, verified Member identity, invites, or multi-Host operation.
- **LH-LATER-002:** Non-Apple-silicon Host Computers and general Linux Tool Runners. Ubuntu 24.04 under WSL2 remains only the explicit Windows Tool Runner lane.
- **LH-LATER-003:** Hosted or paid providers, public search instances, paid or metered APIs, gated/authenticated model stores, billing-backed free tiers, or trials.
- **LH-LATER-004:** Model training, adapters, automatic fitting during test/run, silent substitution, hidden discovery, background acquisition, or automatic updates.
- **LH-LATER-005:** Persistent Host-side Member chat, Attachment, browser, document, image, research, gallery, or memory libraries.
- **LH-LATER-006:** Browser Chat access to Host files, shell, Python, MCP, secrets, private LAN devices, or administration.
- **LH-LATER-007:** Ordinary Codex session/configuration/auth import; ordinary plugins, remote plugins, skills, agents, MCP, hosted search, unified exec, or Responses WebSockets.
- **LH-LATER-008:** Browser, device, Host, model capability, or Tool Runner lanes not named and proven by the exact release.
- **LH-LATER-009:** SearXNG modification, image mirroring/bundling, raw LAN exposure, or copying AGPL code into LocalHub without a new explicit distribution/license decision.
- **LH-LATER-010:** Universal answer-quality, speed, or hardware-compatibility claims beyond recorded exact Profile Results.

## Further Notes

### Source Decision Index

- **D01:** [Wayfinder: Define LocalHub v1 as a private household AI host](https://github.com/scwlkr/LocalHub/issues/1) — closed canonical map.
- **D02:** [Research the current llama.cpp control surface for LocalHub v1](https://github.com/scwlkr/LocalHub/issues/2#issuecomment-5080106948).
- **D03:** [Research zero-spend Browser Chat web search](https://github.com/scwlkr/LocalHub/issues/3#issuecomment-5080101080).
- **D04:** [Research the LAN gateway and browser constraints](https://github.com/scwlkr/LocalHub/issues/4#issuecomment-5080106102).
- **D05:** [Research the Codex Tool Runner client contract](https://github.com/scwlkr/LocalHub/issues/5#issuecomment-5080132232).
- **D06:** [Research zero-cost macOS bundling, updates, and rollback](https://github.com/scwlkr/LocalHub/issues/6#issuecomment-5080137398).
- **D07:** [Decide the fair Request Queue contract](https://github.com/scwlkr/LocalHub/issues/7#issuecomment-5083826323).
- **D08:** [Prototype the Host model control room](https://github.com/scwlkr/LocalHub/issues/8#issuecomment-5085130744).
- **D09:** [Decide the model acquisition and capability contract](https://github.com/scwlkr/LocalHub/issues/9#issuecomment-5083856242).
- **D10:** [Decide the safe Browser Tool and Web Search contract](https://github.com/scwlkr/LocalHub/issues/10#issuecomment-5085285101).
- **D11:** [Prototype the Member Browser Chat experience](https://github.com/scwlkr/LocalHub/issues/11#issuecomment-5085355635).
- **D12:** [Prototype First Run Setup and reversible updates](https://github.com/scwlkr/LocalHub/issues/12#issuecomment-5092157556).
- **D13:** [Define the v1 acceptance contract and implementation handoff](https://github.com/scwlkr/LocalHub/issues/13#issuecomment-5093166580).
- **D14:** [Decide the SearXNG bundling and license boundary](https://github.com/scwlkr/LocalHub/issues/14#issuecomment-5085725046).
- **D15:** [Prove the Codex and llama.cpp compatibility seam](https://github.com/scwlkr/LocalHub/issues/15#issuecomment-5087033366).
- **D16:** [Prototype the local Codex Tool Runner journey](https://github.com/scwlkr/LocalHub/issues/16#issuecomment-5092985615).
- **D17:** [Decide the zero-spend macOS trust experience](https://github.com/scwlkr/LocalHub/issues/17#issuecomment-5091896084).
- **D18:** [Prototype the Host tool workspace and authority controls](https://github.com/scwlkr/LocalHub/issues/18#issuecomment-5092643136).
- **D19:** [Decide the isolated Codex Tool Runner capability boundary](https://github.com/scwlkr/LocalHub/issues/19#issuecomment-5092847438).

### Accepted interaction references

These are decision artifacts only. Production implementation must reproduce the accepted behavior and accessibility contract, not reuse the prototype as product code.

- [Evidence Ledger Host model control room](https://github.com/scwlkr/LocalHub/tree/codex/prototype-host-model-control-room/prototypes/host-model-control-room) — D08.
- [Quiet Conversation Member Browser Chat](https://github.com/scwlkr/LocalHub/tree/codex/prototype-member-browser-chat/prototypes/member-browser-chat) — D11.
- [Guided Runway First Run and reversible lifecycle](https://github.com/scwlkr/LocalHub/tree/codex/prototype-first-run-setup/prototypes/first-run-setup) — D12.
- [Authority Ledger Host Tool Workspace](https://github.com/scwlkr/LocalHub/tree/codex/prototype-host-tool-workspace/prototypes/host-tool-workspace) — D18.
- [Seven-stage local Codex Tool Runner journey](https://github.com/scwlkr/LocalHub/tree/codex/prototype-local-codex-tool-runner/prototypes/local-codex-tool-runner) — D16.

### Handoff rule

This document is the parent contract for future dependency-wired vertical implementation tickets. Each future ticket must cite its requirement and journey gate IDs, name deterministic checks and live platform/model gates, and identify the sanitized evidence destination. An implementation ticket is complete only when its code is on `main` and its evidence is linked. A pull request, mock, CI-only result, prototype, or unrun physical/provider gate remains an explicit blocker.

No implementation tickets are created as part of publishing this specification.
