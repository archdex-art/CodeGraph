// Pure credential-check logic for the optional HTTP Basic Auth gate, kept
// separate from proxy.ts's Next.js request/response glue so it's testable
// without mocking NextRequest.

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate a raw `Authorization` header value against expected Basic Auth
 * credentials. Returns false for a missing/malformed header, a non-Basic
 * scheme, or a credential mismatch — never throws.
 */
export function checkBasicAuth(authorizationHeader: string | null, expectedUser: string, expectedPassword: string): boolean {
  if (!authorizationHeader?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(authorizationHeader.slice(6));
    const sep = decoded.indexOf(":");
    const gotUser = sep === -1 ? decoded : decoded.slice(0, sep);
    const gotPass = sep === -1 ? "" : decoded.slice(sep + 1);
    return timingSafeEqual(gotUser, expectedUser) && timingSafeEqual(gotPass, expectedPassword);
  } catch {
    return false;
  }
}
