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

const PRIVATE_HOSTNAME_RE = /^(localhost|.*\.localhost|.*\.local)$/i;

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 0) return true; // "this network"
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1") return true; // loopback
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local (fc00::/7)
  if (h.startsWith("fe80:")) return true; // link-local
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
