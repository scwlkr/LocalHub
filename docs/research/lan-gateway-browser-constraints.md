# LAN gateway and browser constraints

Research date: 2026-07-25

## Question

On an Apple Silicon macOS Host and current phone and desktop browsers, what
zero-cost mechanisms can provide LocalHub's friendly LAN address, IP and QR
fallback, streaming Browser Chat, temporary Attachments, browser-local history,
and no-account access without exposing Host controls or private-network
resources?

## Decision

Local Gateway v1 should be a same-origin HTTP application on one selected
private LAN interface, with a separate loopback-only Host control surface.
Members use the Mac's actual Bonjour local hostname when it works and a current
private IPv4 address encoded in an offline-generated QR code when it does not.
The Member gateway may be open to the selected local subnet, but the Host
dashboard, model controls, filesystem, shell, and arbitrary network fetching
must never be routed through that listener.

This is feasible at zero cost, with five honest limitations:

1. A `.local` name is best-effort and link-local, not a universal DNS name.
2. Member HTTP is not encrypted and is not a browser secure context.
3. Browser history is best-effort, origin-bound storage, not a durable account.
4. A sleeping Host is unavailable; wake-on-network cannot be promised.
5. No account means the selected LAN subnet is the access boundary. Member
   Labels are not identities.

## Required topology

| Surface | Listener | Reachable by | Contains |
| --- | --- | --- | --- |
| Host control | loopback only (`127.0.0.1` and, if tested, `::1`) | Host Computer | dashboard, model/profile management, queue control, lifecycle controls |
| Member gateway | one Host-approved private LAN interface and persisted unprivileged port | peers on that interface's subnet | Browser Chat, Shared Models, safe Browser Tools, queue status, temporary upload routes |
| Inference engine | loopback or a private process channel | LocalHub only | llama.cpp control and inference APIs |

`Bun.serve` accepts explicit `hostname` and `port` options, so v1 can create
separate listeners rather than depending on path checks on a server bound to
every interface. It also exposes the socket peer address through
`server.requestIP()` for a same-subnet check. [Bun HTTP server]

The Member listener must not bind `0.0.0.0`, a globally routable IPv6 address,
VPN interfaces, or every active interface. It should bind the Host-selected
RFC 1918 IPv4 address; a later implementation may add tested IPv6 ULA support,
but must never advertise or accept a globally routable IPv6 address by default.
Use the socket peer address, not `X-Forwarded-For`, to require the peer to be on
the selected interface's subnet. Do not create UPnP, NAT-PMP, router port
forwarding, tunnel, relay, or cloud resources.

This boundary is deliberately narrower than "any private IP." Private address
space is reused across home networks and VPNs, and the emerging browser Local
Network Access model explicitly calls out cross-network confusion. [Local
Network Access specification]

## Member Link, Bonjour, port, and QR fallback

### Friendly name

Use the actual name that macOS currently publishes, for example:

```text
http://Shanes-Mac.local:<member-port>
```

Apple documents the Mac local hostname as the computer name with `.local`
added, and it may add a number when a conflict exists. LocalHub therefore must
read and display the resolved name; it must not hard-code `localhub.local` or
silently rename the Mac. [Apple: change the local hostname]

Bonjour/mDNS is a sound zero-cost mechanism: `.local` queries are multicast on
the local link, need no conventional DNS server, and are explicitly scoped to
devices not separated by a router. Names can conflict and be renamed. [RFC
6762] [Apple Bonjour naming]

LocalHub should also publish its HTTP service through Bonjour/DNS-SD so native
service browsers can discover its hostname and port. DNS-SD service discovery
returns a service instance, hostname, and port; it does not make a web browser
magically omit a nonstandard port from a typed URL. [Apple Bonjour overview]

Consequences:

- `.local` can fail when multicast is filtered, the Member is on an isolated
  guest network, the devices are on different routed links/VLANs, or the client
  resolver does not implement mDNS correctly. Treat it as the friendly primary
  link, never the only link.
- Display the actual Bonjour name and test it before declaring the Member Link
  ready.
- If two LocalHub Hosts conflict, show the conflict-resolved name rather than
  pretending the requested name succeeded.

### Port stability

Choose an available unprivileged port during First Run Setup and persist it.
Reuse it on every LocalHub Run. If it is occupied, stop with a clear conflict
and let the Host approve a new persisted port; do not silently choose a random
port. Android's official DNS-SD guidance warns that hard-coded ports can
conflict and recommends advertising the actual chosen port. [Android network
service discovery]

The persisted port is also a data constraint: browser storage is separated by
origin, and the origin includes scheme, hostname, and port. Changing the port
creates a different Browser Chat history. [MDN storage quotas]

### IP and QR fallback

The Host dashboard should always show:

- the friendly `.local` URL;
- the current selected RFC 1918 IPv4 URL with the same port;
- an offline-generated QR code containing the current IPv4 URL; and
- a one-line warning that the URL works only on the same local network.

The IP QR is the reliable fallback because it avoids client mDNS resolution.
Generate it locally; never send the URL or QR payload to a hosted QR service.
Regenerate it whenever the selected interface, address, or approved port
changes. A saved IP QR can become stale after DHCP changes.

## HTTP, HTTPS, and secure-context limits

Use plain HTTP for the Member gateway in v1. Do not issue a self-signed
certificate and ask every Member to bypass a warning or install a private root.
Public certificate authorities cannot validate names such as `localhost`; a
locally generated certificate is trusted only after installing its root on
each client. The same ownership problem applies to an ad hoc `.local` name.
[Let's Encrypt: certificates for localhost]

This choice must be visible in the product, not described as secure transport:

- `http://127.0.0.1` and `http://localhost` are potentially trustworthy because
  they stay on the same computer.
- `http://<host>.local` and `http://192.168.x.x` are not potentially
  trustworthy under the Secure Contexts algorithm. Only HTTPS/WSS, loopback,
  localhost, and a few special schemes qualify by default. [W3C Secure
  Contexts]
- Therefore the Host's loopback dashboard may use secure-context APIs, while
  Browser Chat must not depend on service workers, WebAuthn, Web Crypto,
  persistent-storage permission, or another secure-context-only feature.
  Service workers require HTTPS except for localhost, and
  `navigator.storage.persist()` is also secure-context-only. [MDN service
  workers] [MDN persistent storage]
- Member prompts, answers, and Attachments cross the Wi-Fi network without TLS
  confidentiality or integrity. This is acceptable only under the explicitly
  trusted-LAN v1 decision; it is not equivalent to privacy from other devices
  or network operators.

An optional, Host-managed HTTPS mode can be a later decision. It must not be a
v1 dependency and must not ship a shared private key.

## Browser access and Local Network Access permissions

Direct top-level navigation to the Member Link should load one local origin,
and its UI, API, upload, and event-stream requests should stay on that same
origin. That avoids a public site acting as a bridge into the LAN.

Browser and operating-system permission behavior is changing:

- Chrome launched its Local Network Access permission work to restrict public
  websites that request private or loopback resources. Chrome identifies
  private IP literals and `.local` names as local destinations and intends to
  extend protection to more request types. [Chrome Local Network Access]
- Apple requires iPhone and iPad apps that interact with local devices to ask
  for local-network permission; denial can block the browser app from reaching
  LocalHub. [Apple local-network privacy]

LocalHub cannot bypass a denied browser/OS permission. Its connection-error UI
and Host diagnostics should tell the Member to allow Local Network access for
their browser and should distinguish that failure from a stopped Host,
firewall block, stale IP, and guest-Wi-Fi client isolation.

Do not depend on one browser's Local Network Access implementation as a
security control. The web specification says private services still must
defend themselves against CSRF, DNS rebinding, and cross-network confusion.
[Local Network Access specification]

## Streaming chat and visible queue position

Use ordinary same-origin `POST` requests for commands/uploads and one
Server-Sent Events (SSE) stream per browser session for server-to-browser
events. The stream should multiplex queue positions, model state, generated
tokens, completion, cancellation, and errors for every request owned by that
anonymous browser session.

SSE fits the traffic direction and current browsers support it. Event IDs and
`Last-Event-ID` allow reconnection, while the protocol's retry field controls
reconnect delay. Multiple SSE connections are a poor fit because HTTP/1.1
browsers commonly impose a low per-origin connection limit; keep one session
stream instead. [WHATWG server-sent events] [MDN server-sent events]

Recommended request flow:

1. The browser submits one Inference Request and any Attachments.
2. The server returns an opaque request ID owned by the browser's anonymous
   session.
3. The single SSE stream emits `queued`, position/wait estimates, `loading`,
   token deltas, and a terminal state.
4. On reconnect, the browser sends its last event ID. LocalHub replays only the
   small, still-ephemeral event buffer for that session.
5. When the browser backgrounds or loses Wi-Fi, the queued/in-progress request
   continues until completion, Host/Member cancellation, or a documented
   expiry. A dropped TCP connection alone must not cancel it.

Bun closes an idle connection after ten seconds by default, including a quiet
stream. The SSE route must call `server.timeout(request, 0)` and send periodic
comment heartbeats; ordinary routes should keep bounded timeouts. [Bun HTTP
server]

The replay buffer and in-flight output are temporary processing state, not
Host-side chat history. Delete them after client acknowledgement or a short
terminal-state grace period. A process restart may fail outstanding requests;
v1 should report that failure rather than persisting Member prompts to recover
them.

## Browser-local history

Store Member Labels, chat text, response text, model choice, tool choice, and
small attachment metadata in IndexedDB. IndexedDB is asynchronous and follows
the same-origin policy, making it preferable to synchronous `localStorage` for
conversation-sized structured data. [MDN IndexedDB]

The UI must state the actual durability contract:

- Data is best-effort by default and may be evicted under storage pressure.
- Private/Incognito browsing normally removes it when the private session
  ends.
- The user can clear it at any time.
- `.local` and raw-IP links are different origins, as are different ports and
  HTTP versus future HTTPS. Their histories cannot see or merge each other.
- Because Member HTTP is not a secure context, v1 cannot request persistent
  storage through `navigator.storage.persist()`.

For that reason the friendly `.local` URL and persisted port are the canonical
history origin. The IP QR is explicitly a fallback with separate history.
LocalHub must not claim that history follows a person or device, and the Host
must not reconstruct it server-side. [MDN storage quotas] [MDN persistent
storage]

Do not put original Attachment bytes into history by default. A browser may
keep a small local preview for the open conversation, but should make the
storage cost and deletion control visible if v1 chooses to persist previews.

## Temporary Attachments

An ordinary `<input type="file">` works over Member HTTP and gives the page
only files the Member deliberately selects. Script cannot set the file-picker
path. The `accept` attribute is only a picker hint and is not validation. [MDN
file input] [MDN File API]

Server requirements:

- Accept only model-supported image/document types advertised by the selected
  Shared Model.
- Enforce a Host-configured file-count, per-file-byte, and total-request-byte
  limit before and while reading the body. Bun exposes
  `maxRequestBodySize`; LocalHub needs a lower product limit as well. [Bun
  Serve API]
- Stream accepted bodies into a LocalHub-owned temporary directory rather than
  buffering an unbounded multipart body in memory.
- Ignore submitted paths, replace filenames with random IDs, use owner-only
  permissions, and validate content signatures instead of trusting the
  browser-reported MIME type or extension.
- Never serve the temporary directory as static files. Resolve downloads by an
  opaque ID owned by the anonymous session.
- Delete each Host copy after inference completion, cancellation, validation
  failure, or request expiry. On startup, sweep abandoned files from a prior
  crash before accepting Members.
- Describe this as deletion of LocalHub's temporary copy, not guaranteed
  forensic secure erasure on SSD storage.

The Host copy may live through a browser disconnect while its request is still
queued or running; otherwise phone backgrounding would unexpectedly destroy a
valid request. It must not live beyond that request's terminal cleanup window.

## No-account LAN access without Host or LAN reach

No account does not mean no session or no request integrity. On first load,
issue a random anonymous session identifier in an `HttpOnly`, `SameSite=Strict`
cookie. It is not an identity or access check; it only scopes a Member's queue,
reconnect stream, and cancellation capability. Member Labels remain freely
changeable and spoofable.

Apply all of these controls:

1. **Keep Host routes off the LAN listener.** A source-address or UI check is
   not enough. The Member process must have no route to model management,
   arbitrary llama.cpp control, lifecycle, shell, or Host files.
2. **Validate the peer subnet.** Take it from the accepted socket, not a proxy
   header. Reject public, loopback, link-local, other-private-subnet, VPN, and
   globally routable IPv6 peers on the Member listener.
3. **Validate `Host` and `Origin`.** Allow only the exact displayed `.local`
   name/current IP plus persisted port, reject unknown `Host` values, reject
   cross-origin state-changing requests, and use an unguessable CSRF token.
   Same-origin policy blocks many reads but normally allows cross-origin forms
   and other writes, so CORS alone is insufficient. [MDN same-origin policy]
4. **Never enable wildcard CORS.** The Browser Chat API is same-origin only.
5. **Constrain rendered content.** Render model output as escaped text or
   sanitized Markdown; no raw HTML, scripts, iframes, objects, forms, or remote
   embeds. Never load images or documents directly from model-provided URLs.
6. **Ship a strict CSP.** At minimum: `default-src 'self'`; `connect-src
   'self'`; `img-src 'self' data: blob:`; `object-src 'none'`; `frame-src
   'none'`; `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'none'`.
   Serve all scripts/styles locally, with no CDN. CSP directly controls the
   destinations scripts, images, frames, and forms can use. [MDN CSP]
7. **Make Browser Tools named capabilities.** The model can request only a
   Host-approved tool ID with a typed input. Do not expose generic `fetch`, a
   URL opener, filesystem paths, shell, llama.cpp control, or arbitrary MCP
   access to Browser Chat.
8. **Make Web Search public-only server egress.** Resolve every destination
   and every redirect immediately before connecting; reject loopback, RFC
   1918, link-local, carrier-grade NAT, ULA, multicast, metadata endpoints,
   the Host's own addresses, and any result with a non-public answer. Limit
   protocols to HTTP/HTTPS, redirects, response bytes, and time. Sanitize
   fetched content into data rather than rendering it as active HTML. Recheck
   on each connection because DNS rebinding can change the resolved address.
   [Local Network Access specification]
9. **Rate-limit even trusted Members.** Enforce per-peer/session and global
   request/upload limits so no-account access cannot bypass the fair Request
   Queue or exhaust disk/memory.

These controls prevent LocalHub's Browser Chat and Browser Tools from becoming
a route to Host or private-LAN resources. They cannot stop a trusted Member
from independently using their own browser, terminal, or another program to
contact devices already reachable from their computer.

## macOS firewall, network changes, sleep, and wake

The macOS application firewall can block all incoming connections, allow or
deny specified apps, and automatically allow some signed software. When an
unapproved app first receives a connection, macOS may ask the Host to allow or
deny it and denies attempts until the Host responds. [Apple firewall security]
[Apple: block connections]

LocalHub must not disable or silently modify the firewall. First Run Setup and
`lh doctor` should:

- verify the member listener locally;
- explain the expected macOS prompt before the first Member connects;
- detect and report `Block all incoming connections` or an explicit LocalHub
  denial;
- show the exact System Settings path for the Host to allow LocalHub; and
- test reachability from a second physical LAN device before saying the Member
  Link works.

Do not assume automatic firewall allowance. The zero-spend distribution path
may not satisfy every signing/notarization condition that macOS uses for
automatic acceptance.

When Wi-Fi/Ethernet changes, LocalHub should withdraw the old Bonjour service,
close the old Member listener, select or ask approval for a new private
interface, rebind, republish, regenerate the IP QR, and invalidate anonymous
sessions tied to the old network. The mDNS standard requires fresh probing and
announcement when connectivity changes. [RFC 6762]

Sleep suspends availability. Apple documents an optional "Wake for network
access" setting, but its behavior is for shared resources and depends on system
and network support. Even low-level apps cannot prevent forced sleep such as a
lid close. LocalHub should not prevent sleep by default and must not promise
wake-on-LAN. [Apple: share resources during sleep] [Apple sleep/wake Q&A]

After wake, the process should treat every client transport as lost, re-check
the interface/address, rebind and republish if necessary, and let browsers
reconnect their SSE stream. Browser Chat should show "Host sleeping/offline"
after a short failure window and recover without losing its browser-local
history.

## Acceptance matrix for implementation

The gateway is not complete until physical clients prove these cases:

| Case | Required result |
| --- | --- |
| macOS firewall on, LocalHub unapproved | Host gets actionable allow guidance; no false "ready" state |
| macOS firewall on, LocalHub allowed | iPhone/Android and desktop client load Member Link |
| `.local` succeeds | displayed actual name opens Browser Chat |
| `.local` fails or is filtered | displayed IPv4 URL and its locally generated QR work |
| guest/client-isolated Wi-Fi | diagnostics explain that peers cannot reach one another |
| DHCP/interface change | old IP is withdrawn, new QR appears, Bonjour republishes |
| two LocalHub Hosts/name conflict | each reports its actual usable name |
| phone background/foreground | one request remains queued/running and stream reconnects without duplicate inference |
| Host sleep/wake | clients show offline, then reconnect after listener/Bonjour recovery |
| browser private mode/site-data clear | history loss matches the warning; Host has no recovery copy |
| `.local` then IP fallback | histories remain separate and UI explains why |
| unsupported or oversized Attachment | rejected before inference; no abandoned temp file |
| malicious cross-origin form/fetch | rejected by Origin/CSRF/Host checks |
| model output containing HTML/LAN URLs | displayed inertly; no browser request reaches that destination |
| Browser Tool URL resolves/redirects to private address | rejected before connection |
| LAN attempt to open Host control route | no route/listener response exists |

Minimum physical browser coverage: current Safari on iPhone, current Chrome on
Android, Safari and Chrome on macOS, and Chrome or Edge on Windows, all against
the Apple Silicon Host. Simulator-only or same-Host tests do not prove the LAN,
firewall, mDNS, QR, sleep, or mobile-background requirements.

## Sources

- [Apple: Change your computer's name or local hostname on Mac](https://support.apple.com/en-bh/guide/mac-help/mchlp2322/mac)
- [Apple: Bonjour](https://developer.apple.com/bonjour/)
- [Apple: Bonjour domain naming conventions](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/NetServices/Articles/domainnames.html)
- [Apple: About Bonjour](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/NetServices/index.html)
- [Apple: Firewall security in macOS](https://support.apple.com/guide/security/firewall-security-in-macos-seca0e83763f/web)
- [Apple: Block connections to your Mac with a firewall](https://support.apple.com/en-euro/guide/mac-help/mh34041/mac)
- [Apple: Local network privacy on iPhone and iPad](https://support.apple.com/en-gb/102229)
- [Apple: Share your Mac resources when it is in sleep](https://support.apple.com/en-mt/guide/mac-help/mh27905/mac)
- [Apple: Registering for sleep and wake notifications](https://developer.apple.com/library/archive/qa/qa1340/_index.html)
- [Android: Use network service discovery](https://developer.android.com/develop/connectivity/wifi/use-nsd)
- [IETF RFC 6762: Multicast DNS](https://datatracker.ietf.org/doc/html/rfc6762)
- [W3C Secure Contexts](https://w3c.github.io/webappsec-secure-contexts/)
- [WICG Local Network Access](https://wicg.github.io/local-network-access/)
- [Chrome: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Let's Encrypt: Certificates for localhost](https://letsencrypt.org/docs/certificates-for-localhost/)
- [WHATWG HTML: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [MDN: Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
- [MDN: IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [MDN: `StorageManager.persist()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [MDN: File API](https://developer.mozilla.org/en-US/docs/Web/API/File_API)
- [MDN: `<input type="file">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)
- [MDN: Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
- [MDN: Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)
- [Bun: HTTP server](https://bun.sh/docs/runtime/http/server)
- [Bun: Serve API](https://bun.sh/reference/bun/Serve)

[Android network service discovery]: https://developer.android.com/develop/connectivity/wifi/use-nsd
[Apple Bonjour naming]: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/NetServices/Articles/domainnames.html
[Apple Bonjour overview]: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/NetServices/index.html
[Apple firewall security]: https://support.apple.com/guide/security/firewall-security-in-macos-seca0e83763f/web
[Apple local-network privacy]: https://support.apple.com/en-gb/102229
[Apple sleep/wake Q&A]: https://developer.apple.com/library/archive/qa/qa1340/_index.html
[Apple: block connections]: https://support.apple.com/en-euro/guide/mac-help/mh34041/mac
[Apple: change the local hostname]: https://support.apple.com/en-bh/guide/mac-help/mchlp2322/mac
[Apple: share resources during sleep]: https://support.apple.com/en-mt/guide/mac-help/mh27905/mac
[Bun HTTP server]: https://bun.sh/docs/runtime/http/server
[Bun Serve API]: https://bun.sh/reference/bun/Serve
[Chrome Local Network Access]: https://developer.chrome.com/blog/local-network-access
[Let's Encrypt: certificates for localhost]: https://letsencrypt.org/docs/certificates-for-localhost/
[Local Network Access specification]: https://wicg.github.io/local-network-access/
[MDN CSP]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
[MDN File API]: https://developer.mozilla.org/en-US/docs/Web/API/File_API
[MDN IndexedDB]: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
[MDN file input]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file
[MDN persistent storage]: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
[MDN same-origin policy]: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy
[MDN server-sent events]: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
[MDN service workers]: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
[MDN storage quotas]: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
[RFC 6762]: https://datatracker.ietf.org/doc/html/rfc6762
[WHATWG server-sent events]: https://html.spec.whatwg.org/multipage/server-sent-events.html
[W3C Secure Contexts]: https://w3c.github.io/webappsec-secure-contexts/
