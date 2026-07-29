// In-process token-bucket rate limiter (F015). Keyed by client IP, scoped by
// a caller-supplied bucket name so different routes don't share a budget.
//
// Deliberately in-memory: CodeGraph runs as a single Node process per Render
// instance (no external queue/cache — see store.ts's same assumption), so a
// process-local map is the correct granularity. It bounds abuse of the only
// unauthenticated routes that do real outbound network / filesystem / OAuth-
// quota work per request; it is not a distributed DoS shield.
import type { NextRequest } from "next/server";
import { config } from "@codegraph/config";

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  retryAfter: number; // seconds until at least one token is available
}

/** Derive a best-effort client IP for rate-limit keying.
 *
 *  Reverse proxies APPEND the peer they saw to `X-Forwarded-For`, so the
 *  trustworthy client address is the Nth entry from the RIGHT (the one the
 *  outermost trusted proxy recorded) — NOT the leftmost, which is fully
 *  attacker-controlled (a client can send any `X-Forwarded-For` it likes and
 *  otherwise mint a fresh empty bucket per request, defeating the limit).
 *
 *  `CG_TRUSTED_PROXY_HOPS` is the number of trusted proxies that append to the
 *  header; default 1 (single reverse proxy, e.g. Render). Set it to 0 for a
 *  directly-exposed deployment to refuse to trust the header at all — that
 *  degrades to a single shared bucket (still bounded, just coarse) rather than
 *  a spoofable per-IP one. A missing header falls back to a constant so the
 *  limit is never silently disabled. */
export function clientIp(req: NextRequest): string {
  const hops = config.trustedProxyHops;
  const trustProxy = hops >= 1;
  if (trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - hops)]!;
    }
    // x-real-ip is set by the proxy to the direct peer; trust it only when we
    // trust a proxy at all, same as X-Forwarded-For.
    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return "unknown";
}

/**
 * Token-bucket check. `capacity` tokens refill at `capacity/windowMs`. Each
 * allowed call spends one token. Returns `{ ok:false, retryAfter }` when the
 * bucket is empty. Pure time math — safe to call on every request.
 */
export function rateLimit(
  key: string,
  { capacity, windowMs }: { capacity: number; windowMs: number },
  now = Date.now(),
): RateLimitResult {
  const refillPerMs = capacity / windowMs;
  const b = buckets.get(key);
  if (!b) {
    buckets.set(key, { tokens: capacity - 1, updated: now });
    return { ok: true, retryAfter: 0 };
  }
  b.tokens = Math.min(capacity, b.tokens + (now - b.updated) * refillPerMs);
  b.updated = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }
  return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerMs / 1000) };
}

/** Test-only: drop all buckets so limits don't leak across test cases. */
export function resetRateLimits(): void {
  buckets.clear();
}
