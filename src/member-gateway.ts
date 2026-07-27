import qrcode from "qrcode-generator";

export interface PrivateInterface {
  name: string;
  address: string;
  netmask: string;
}

export interface MemberBinding {
  interface: PrivateInterface;
  bonjourName: string;
  port: number;
  friendlyUrl: string;
  ipv4Url: string;
  qrPayload: string;
  qrSvg: string;
  qrAscii: string;
}

export interface CreateMemberBindingOptions {
  selected: PrivateInterface;
  available: PrivateInterface[];
  bonjourName: string;
  port: number;
}

export type MemberBindingReconciliation =
  | { status: "current" }
  | {
      status: "withdrawn";
      failure: {
        cause: string;
        protectedState: string;
        stillWorks: string;
        repair: string;
        recheck: string;
      };
    };

const MEMBER_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");

export async function createMemberBinding(
  options: CreateMemberBindingOptions,
): Promise<MemberBinding> {
  assertPort(options.port);
  if (!isPrivateIpv4(options.selected.address)) {
    throw new Error("The selected Member interface must have one RFC 1918 private IPv4 address.");
  }
  parseIpv4(options.selected.netmask, "selected interface netmask");
  const current = options.available.find(
    (item) =>
      item.name === options.selected.name &&
      item.address === options.selected.address &&
      item.netmask === options.selected.netmask,
  );
  if (!current) {
    throw new Error(
      "The selected private interface or address changed. The Member gateway remains closed until an explicit recheck.",
    );
  }
  const bonjourName = normalizeBonjourName(options.bonjourName);
  const friendlyUrl = `http://${bonjourName}:${options.port}`;
  const ipv4Url = `http://${current.address}:${options.port}`;
  const qr = createQr(ipv4Url);
  return {
    interface: { ...current },
    bonjourName,
    port: options.port,
    friendlyUrl,
    ipv4Url,
    qrPayload: ipv4Url,
    qrSvg: qr.svg,
    qrAscii: qr.ascii,
  };
}

export function isPrivateIpv4(address: string): boolean {
  let parts: number[];
  try {
    parts = parseIpv4(address, "address");
  } catch {
    return false;
  }
  const [first = -1, second = -1] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isPeerOnSelectedSubnet(peerAddress: string, selected: PrivateInterface): boolean {
  const normalized = peerAddress.startsWith("::ffff:") ? peerAddress.slice(7) : peerAddress;
  if (!isPrivateIpv4(normalized)) return false;
  try {
    const peer = ipv4Integer(normalized);
    const host = ipv4Integer(selected.address);
    const mask = ipv4Integer(selected.netmask);
    return (peer & mask) === (host & mask);
  } catch {
    return false;
  }
}

export function reconcileMemberBinding(
  binding: MemberBinding,
  available: PrivateInterface[],
): MemberBindingReconciliation {
  const current = available.some(
    (item) =>
      item.name === binding.interface.name &&
      item.address === binding.interface.address &&
      item.netmask === binding.interface.netmask,
  );
  if (current) return { status: "current" };
  return {
    status: "withdrawn",
    failure: {
      cause: "The selected private interface or address changed after start or wake.",
      protectedState:
        "The old Member Link is closed; Host control remains loopback-only and no alternate interface was selected.",
      stillWorks: "The Host dashboard and exact Run remain available on the Host Computer.",
      repair: "Confirm the intended private interface, then run the explicit Member recheck.",
      recheck: "Run `lh member recheck` and open both newly displayed Member links again.",
    },
  };
}

export function createMemberGatewayHandler(
  binding: MemberBinding,
  peerAddress: (request: Request) => string | null,
  onVisit: (route: "friendly" | "ipv4", peerAddress: string) => void = () => undefined,
): (request: Request) => Promise<Response> {
  const allowedHosts = new Map([
    [`${binding.bonjourName}:${binding.port}`.toLowerCase(), "friendly" as const],
    [`${binding.interface.address}:${binding.port}`.toLowerCase(), "ipv4" as const],
  ]);
  return async (request) => {
    const peer = peerAddress(request);
    if (!peer || !isPeerOnSelectedSubnet(peer, binding.interface)) {
      return memberResponse("Selected local network only.", { status: 403 });
    }
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    const route = allowedHosts.get(host);
    if (!route) {
      return memberResponse("Member Link host did not match.", { status: 421 });
    }
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        if (!allowedHosts.has(new URL(origin).host.toLowerCase())) {
          return memberResponse("Cross-origin Member request denied.", { status: 403 });
        }
      } catch {
        return memberResponse("Cross-origin Member request denied.", { status: 403 });
      }
    }
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/" || path === "/readiness")) {
      onVisit(route, peer);
      return memberResponse(renderMemberPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return memberResponse("Not found", { status: 404 });
  };
}

export function renderHostDashboard(
  binding: MemberBinding | null,
  run: { runId?: string; status: string; acceptingWork: boolean },
): string {
  const link = binding
    ? `<p><strong>Member Link</strong><br><a href="${escapeHtml(binding.friendlyUrl)}">${escapeHtml(binding.friendlyUrl)}</a><br><a href="${escapeHtml(binding.ipv4Url)}">${escapeHtml(binding.ipv4Url)}</a></p><div class="qr">${binding.qrSvg}</div><p>Same trusted local network only. The QR contains the private IPv4 fallback and was generated locally.</p>`
    : "<p>The Member Link is closed until the selected private interface passes recheck.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocalHub Host</title><style>${baseCss()}</style></head>
<body><main><p class="eyebrow">LOCALHUB HOST</p><h1>${escapeHtml(run.status)}</h1><p>New work: ${run.acceptingWork ? "accepted" : "rejected"}</p>${link}<section><h2>Ready means the Host is available</h2><p>A passing Shared Model is still required before Members can run inference.</p></section>${run.runId ? `<form method="post" action="/stop?run-id=${encodeURIComponent(run.runId)}"><button type="submit">Stop LocalHub</button></form><p>Stop rejects new work and closes the Member Link and LocalHub-owned services. It does not delete models or uninstall LocalHub.</p>` : ""}</main></body></html>`;
}

function renderMemberPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocalHub Member</title><style>${baseCss()}</style></head>
<body><main><p class="eyebrow">LOCALHUB MEMBER</p><h1>Member Link ready</h1><p>This page is available only on the Host-selected trusted local network.</p><section><h2>No model is available yet</h2><p>An exact acquired, tested, shared, and passing Shared Model is still required before inference is available.</p></section><p>Host controls, files, shell, and private-network tools are not available here.</p></main></body></html>`;
}

function memberResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", MEMBER_CSP);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(body, { ...init, headers });
}

function createQr(payload: string): { svg: string; ascii: string } {
  const qr = qrcode(0, "M");
  qr.addData(payload, "Byte");
  qr.make();
  const quiet = 4;
  const count = qr.getModuleCount();
  const size = count + quiet * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) {
        cells.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Member Link IPv4 QR code" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${cells.join("")}" fill="black"/></svg>`,
    ascii: qr.createASCII(1, quiet),
  };
}

function normalizeBonjourName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 253 ||
    !normalized.endsWith(".local") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      normalized,
    )
  ) {
    throw new Error("The actual Bonjour local hostname is unavailable or invalid.");
  }
  return normalized;
}

function parseIpv4(value: string, label: string): number[] {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(`Invalid ${label}.`);
  }
  return parts.map(Number);
}

function ipv4Integer(value: string): number {
  return parseIpv4(value, "IPv4 address").reduce((result, part) => ((result << 8) | part) >>> 0, 0);
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("The Member port must be an unprivileged TCP port.");
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function baseCss(): string {
  return "*{box-sizing:border-box}body{margin:0;background:#071014;color:#eafcff;font:18px/1.55 system-ui,sans-serif}main{max-width:48rem;margin:auto;padding:clamp(1.5rem,7vw,5rem)}h1{font-size:clamp(2.4rem,8vw,5rem);line-height:1;margin:.2em 0}h2{font-size:1.25rem}a{color:#39e7ff}.eyebrow{color:#39e7ff;letter-spacing:.18em;font-weight:700}section{border-left:.3rem solid #39e7ff;padding:.1rem 1.2rem;margin:2rem 0}.qr{max-width:18rem;background:white;padding:.75rem}.qr svg{display:block;width:100%;height:auto}button{background:#39e7ff;border:0;border-radius:.35rem;color:#071014;font:inherit;font-weight:800;padding:.75rem 1rem}:focus-visible{outline:.2rem solid #fff;outline-offset:.2rem}@media(max-width:30rem){body{font-size:16px}}";
}
