// In-process token-bucket rate limiter (F015). Keyed by client IP, scoped by
// a caller-supplied bucket name so different routes don't share a budget.
//
// Deliberately in-memory: CodeGraph runs as a single Node process per Render
// instance (no external queue/cache — see store.ts's same assumption), so a
// process-local map is the correct granularity. It bounds abuse of the only
// unauthenticated routes that do real outbound network / filesystem / OAuth-
// quota work per request; it is not a distributed DoS shield.
import type { NextRequest } from "next/server";

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  retryAfter: number; // seconds until at least one token is available
}

/** Derive a best-effort client IP from proxy headers, falling back to a
 *  constant so a missing header degrades to a shared (still-bounded) bucket
 *  rather than silently disabling the limit. */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
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
