/**
 * SSRF guard for the secret proxy. Returns null if the URL may be fetched, or a
 * short reason. Reasons never echo the URL, since it may contain a substituted secret.
 */
export function checkProxyUrl(raw: string, opts: { domain: string; allowHttp: boolean }): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid absolute URL";
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return "only https URLs are allowed";
  if (u.username || u.password) return "URLs with embedded credentials are not allowed";
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return "missing host";

  if (host.startsWith("[") && host.endsWith("]")) {
    return isBlockedIPv6(host.slice(1, -1)) ? "private or reserved IPv6 addresses are not allowed" : null;
  }
  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4) ? "private or reserved IPv4 addresses are not allowed" : null;

  if (host === "localhost" || host.endsWith(".localhost")) return "localhost is not allowed";
  if (host.endsWith(".local") || host.endsWith(".internal") || host === "local" || host === "internal") {
    return "internal host names are not allowed";
  }
  const domain = opts.domain.toLowerCase().replace(/\.$/, "");
  if (domain && (host === domain || host.endsWith("." + domain))) return "the proxy cannot call this platform";
  if (!host.includes(".")) return "single-label host names are not allowed";
  return null;
}

/** WHATWG URL parsing has already canonicalized decimal/hex/octal forms to dotted quads. */
function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isBlockedIPv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 || // 0.0.0.0/8 ("this network", includes 0.0.0.0)
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function parseIPv6(s: string): number[] | null {
  // Embedded dotted IPv4 tail (URL parsing usually rewrites it to hex, but be safe).
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const v4 = parseIPv4(tail[1]!);
    if (!v4) return null;
    s = s.slice(0, -tail[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isBlockedIPv6(s: string): boolean {
  const g = parseIPv6(s);
  if (!g) return true; // unparseable: refuse
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embeddedV4 = () => [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isBlockedIPv4(embeddedV4()); // IPv4-mapped / IPv4-compatible
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedIPv4(embeddedV4()); // NAT64
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2002) return isBlockedIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}
