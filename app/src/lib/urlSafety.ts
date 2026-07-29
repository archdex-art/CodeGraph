// Best-effort SSRF guard for user-supplied git URLs. `git clone` makes a
// real network request server-side, so an unvalidated URL lets a visitor
// point this server at itself or its private network (e.g. a cloud
// provider's 169.254.169.254 metadata endpoint) and read back whatever git
// error/response leaks.
//
// This blocks the common, literal cases: loopback/private/link-local IPs and
// `localhost`-style hostnames in the URL string. It does NOT defend against
// DNS rebinding (a hostname that resolves to a private IP only at connect
// time) — that requires resolving DNS ourselves and pinning the connection
// to the validated address, which `git clone`'s own network stack doesn't
// give us a hook for. Treat this as raising the bar, not a complete guarantee.

// `.internal` covers GCP's metadata.google.internal and the ".internal" TLD
// convention generally; `.local` is mDNS; `.home.arpa` is the reserved
// residential-network zone.
const PRIVATE_HOSTNAME_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/**
 * Normalise any inet_aton-style IPv4 spelling into dotted-quad, or return null
 * if `host` isn't an IPv4 literal at all.
 *
 * NOTE ON WHY THIS IS DEFENCE IN DEPTH, NOT A BYPASS FIX: Node's WHATWG `URL`
 * already normalises these itself — `new URL("http://0x7f000001/").hostname`
 * is `"127.0.0.1"` — so `isPublicHttpUrl`, which parses before it checks, was
 * never bypassable this way. Verified, not assumed. This function exists so
 * the predicate is still correct if it is ever handed a raw host string from
 * somewhere that didn't go through `URL` (a git remote read off disk, a config
 * value, a redirect target), which is exactly the kind of call site that gets
 * added later without anyone re-reading this file.
 *
 * The rules are inet_aton's: 1–4 dot-separated parts, each decimal, octal
 * (leading 0) or hex (leading 0x); the final part absorbs all remaining bytes.
 */
function normalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null; // contains a letter → a hostname, not an IP literal
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }

  // Every part except the last must fit in one byte; the last absorbs the rest.
  const last = nums[nums.length - 1];
  const leading = nums.slice(0, -1);
  if (leading.some((n) => n > 0xff)) return null;
  const maxLast = Math.pow(256, 4 - leading.length);
  if (last >= maxLast) return null;

  let value = 0;
  for (const n of leading) value = value * 256 + n;
  value = value * maxLast + last;

  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

function isPrivateIPv4(host: string): boolean {
  const dotted = normalizeIPv4(host);
  if (!dotted) return false;
  const [a, b] = dotted.split(".").map(Number);
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Pull the embedded IPv4 address out of an IPv4-mapped/compatible IPv6
 * literal, in either spelling, or null.
 *
 * The hex spelling is the one that actually matters in practice, because it is
 * what `URL` hands you: `new URL("http://[::ffff:169.254.169.254]/").hostname`
 * is `"[::ffff:a9fe:a9fe]"`, NOT the dotted form the attacker typed. A check
 * that only understands the dotted form sees an unfamiliar v6 address and
 * waves the cloud metadata endpoint straight through.
 */
function embeddedIPv4(h: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) return dotted[1];

  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
  }
  return null;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (/^f[cd]/.test(h)) return true; // unique local (fc00::/7)
  if (h.startsWith("fe80:")) return true; // link-local

  const v4 = embeddedIPv4(h);
  if (v4) return isPrivateIPv4(v4);

  // 6to4 (2002::/16) and Teredo (2001:0::/32) tunnel to a v4 destination we
  // cannot vet from the address alone, so refuse both outright.
  if (h.startsWith("2002:") || h.startsWith("2001:0:")) return true;
  return false;
}

/** True if `url` looks like a public https/http git remote, not a loopback/private/link-local target. */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname;
  if (!host) return false;
  if (PRIVATE_HOSTNAME_RE.test(host)) return false;
  if (isPrivateIPv4(host)) return false;
  if (isPrivateIPv6(host)) return false;

  return true;
}

/** True if `path` is safe to use as a same-origin post-login redirect
 *  target — a relative path starting with exactly one `/`. Rejects
 *  absolute URLs (`https://evil.example`) and protocol-relative URLs
 *  (`//evil.example`, which browsers resolve against `evil.example` as the
 *  host using the current protocol) that would otherwise redirect a
 *  freshly authenticated session to an attacker-controlled origin. */
export function isSafeReturnPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
