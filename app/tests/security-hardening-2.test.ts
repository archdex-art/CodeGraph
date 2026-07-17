// Regression tests for the second security-hardening pass covering the
// remaining open findings from docs/AUDIT_2026-07-12.md's Security bucket:
// F011 (write-size cap), F012 (server-side session expiry), F013
// (scheme-derived Secure cookie flag), F015 (rate limiting), F016
// (/api/browse root scoping), F022 (constant-time OAuth state compare).
// Each suite locks in the fix AND verifies the corresponding legitimate
// path still works unchanged.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  writeWorkspaceFile,
  createEntry,
  MAX_WRITE_BYTES,
  WorkspacePathError,
} from "@/lib/workspace";
import {
  encryptSession,
  decryptSession,
  requestIsSecure,
  SESSION_MAX_AGE_S,
} from "@/lib/session";
import { rateLimit, resetRateLimits, clientIp } from "@/lib/rateLimit";
import { timingSafeEqual } from "@/lib/basicAuth";

process.env.CG_SESSION_SECRET = process.env.CG_SESSION_SECRET || "test-secret-for-security-hardening-2";

describe("writeWorkspaceFile / createEntry (F011 — write size cap)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cg-writecap-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("still writes an ordinary small file — no functional regression", () => {
    writeWorkspaceFile(root, "a.txt", "hello world");
    expect(() => createEntry(root, "b.txt", "file")).not.toThrow();
  });

  it("rejects a write over the byte cap", () => {
    const big = "x".repeat(MAX_WRITE_BYTES + 1);
    expect(() => writeWorkspaceFile(root, "too-big.txt", big)).toThrow(WorkspacePathError);
  });

  it("accepts a write exactly at the byte cap", () => {
    const exact = "x".repeat(MAX_WRITE_BYTES);
    expect(() => writeWorkspaceFile(root, "exact.txt", exact)).not.toThrow();
  });
});

describe("session expiry (F012 — server-side enforcement, not just cookie Max-Age)", () => {
  it("accepts a freshly issued session", () => {
    const token = encryptSession({
      userId: 1, login: "u", name: null, avatarUrl: "", accessToken: "t", issuedAt: Date.now(),
    });
    expect(decryptSession(token)).not.toBeNull();
  });

  it("rejects a session whose issuedAt is older than SESSION_MAX_AGE_S, even though the GCM tag is valid", () => {
    const expired = Date.now() - (SESSION_MAX_AGE_S * 1000 + 60_000);
    const token = encryptSession({
      userId: 1, login: "u", name: null, avatarUrl: "", accessToken: "t", issuedAt: expired,
    });
    expect(decryptSession(token)).toBeNull();
  });

  it("accepts a session just under the expiry boundary", () => {
    const almostExpired = Date.now() - (SESSION_MAX_AGE_S * 1000 - 60_000);
    const token = encryptSession({
      userId: 1, login: "u", name: null, avatarUrl: "", accessToken: "t", issuedAt: almostExpired,
    });
    expect(decryptSession(token)).not.toBeNull();
  });

  it("still fails closed on a tampered payload (unrelated to expiry)", () => {
    const token = encryptSession({
      userId: 1, login: "u", name: null, avatarUrl: "", accessToken: "t", issuedAt: Date.now(),
    });
    expect(decryptSession(token.slice(0, -4) + "abcd")).toBeNull();
  });
});

describe("requestIsSecure (F013 — Secure cookie flag derived from the actual connection, not NODE_ENV)", () => {
  const ORIGINAL_FORCE = process.env.CG_FORCE_SECURE_COOKIES;
  afterEach(() => {
    if (ORIGINAL_FORCE === undefined) delete process.env.CG_FORCE_SECURE_COOKIES;
    else process.env.CG_FORCE_SECURE_COOKIES = ORIGINAL_FORCE;
  });

  it("trusts x-forwarded-proto: https behind a reverse proxy", () => {
    delete process.env.CG_FORCE_SECURE_COOKIES;
    const req = new NextRequest("http://internal-host/", { headers: { "x-forwarded-proto": "https" } });
    expect(requestIsSecure(req)).toBe(true);
  });

  it("treats a plain http request (no proxy header) as insecure", () => {
    delete process.env.CG_FORCE_SECURE_COOKIES;
    const req = new NextRequest("http://example.com/");
    expect(requestIsSecure(req)).toBe(false);
  });

  it("treats an https request URL as secure even without a proxy header", () => {
    delete process.env.CG_FORCE_SECURE_COOKIES;
    const req = new NextRequest("https://example.com/");
    expect(requestIsSecure(req)).toBe(true);
  });

  it("CG_FORCE_SECURE_COOKIES=true overrides everything", () => {
    process.env.CG_FORCE_SECURE_COOKIES = "true";
    const req = new NextRequest("http://example.com/");
    expect(requestIsSecure(req)).toBe(true);
  });

  it("CG_FORCE_SECURE_COOKIES=false overrides everything", () => {
    process.env.CG_FORCE_SECURE_COOKIES = "false";
    const req = new NextRequest("https://example.com/");
    expect(requestIsSecure(req)).toBe(false);
  });
});

describe("rateLimit (F015 — token bucket)", () => {
  beforeEach(() => resetRateLimits());

  it("allows requests up to capacity, then rejects with a retryAfter", () => {
    const key = "test-bucket-1";
    const opts = { capacity: 3, windowMs: 60_000 };
    const t0 = 1_000_000;
    expect(rateLimit(key, opts, t0).ok).toBe(true);
    expect(rateLimit(key, opts, t0).ok).toBe(true);
    expect(rateLimit(key, opts, t0).ok).toBe(true);
    const fourth = rateLimit(key, opts, t0);
    expect(fourth.ok).toBe(false);
    expect(fourth.retryAfter).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    const key = "test-bucket-2";
    const opts = { capacity: 1, windowMs: 1000 };
    const t0 = 2_000_000;
    expect(rateLimit(key, opts, t0).ok).toBe(true);
    expect(rateLimit(key, opts, t0).ok).toBe(false); // no tokens left
    expect(rateLimit(key, opts, t0 + 1000).ok).toBe(true); // fully refilled after one window
  });

  it("keys are independent — a different bucket key isn't affected", () => {
    const opts = { capacity: 1, windowMs: 60_000 };
    const t0 = 3_000_000;
    expect(rateLimit("bucket-a", opts, t0).ok).toBe(true);
    expect(rateLimit("bucket-a", opts, t0).ok).toBe(false);
    expect(rateLimit("bucket-b", opts, t0).ok).toBe(true); // separate bucket, unaffected
  });
});

describe("clientIp", () => {
  it("uses the first hop of x-forwarded-for", () => {
    const req = new NextRequest("http://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = new NextRequest("http://x/", { headers: { "x-real-ip": "9.9.9.9" } });
    expect(clientIp(req)).toBe("9.9.9.9");
  });

  it("falls back to a constant when no IP header is present, instead of silently disabling the limit", () => {
    const req = new NextRequest("http://x/");
    expect(clientIp(req)).toBe("unknown");
  });
});

describe("timingSafeEqual (F022 — reused for OAuth state comparison)", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings, including different lengths", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    expect(timingSafeEqual("abc123", "abc12")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("/api/browse CG_LOCAL_ACCESS_ROOT scoping (F016)", () => {
  const ORIGINAL = process.env.CG_LOCAL_ACCESS_ROOT;
  const ORIGINAL_LOCAL = process.env.CG_ALLOW_LOCAL_ACCESS;
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cg-browse-root-"));
    outside = mkdtempSync(path.join(tmpdir(), "cg-browse-outside-"));
    mkdirSync(path.join(root, "inside-dir"));
    process.env.CG_ALLOW_LOCAL_ACCESS = "true";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (ORIGINAL === undefined) delete process.env.CG_LOCAL_ACCESS_ROOT;
    else process.env.CG_LOCAL_ACCESS_ROOT = ORIGINAL;
    if (ORIGINAL_LOCAL === undefined) delete process.env.CG_ALLOW_LOCAL_ACCESS;
    else process.env.CG_ALLOW_LOCAL_ACCESS = ORIGINAL_LOCAL;
  });

  it("without CG_LOCAL_ACCESS_ROOT set, any path is still browsable (unrestricted default preserved)", async () => {
    delete process.env.CG_LOCAL_ACCESS_ROOT;
    const { GET } = await import("@/app/api/browse/route");
    const res = await GET(new NextRequest(`http://x/api/browse?path=${encodeURIComponent(outside)}`));
    expect(res.status).toBe(200);
  });

  it("with CG_LOCAL_ACCESS_ROOT set, a path inside the root is allowed", async () => {
    process.env.CG_LOCAL_ACCESS_ROOT = root;
    const { GET } = await import("@/app/api/browse/route");
    const res = await GET(new NextRequest(`http://x/api/browse?path=${encodeURIComponent(path.join(root, "inside-dir"))}`));
    expect(res.status).toBe(200);
  });

  it("with CG_LOCAL_ACCESS_ROOT set, a path outside the root is rejected with 403", async () => {
    process.env.CG_LOCAL_ACCESS_ROOT = root;
    const { GET } = await import("@/app/api/browse/route");
    const res = await GET(new NextRequest(`http://x/api/browse?path=${encodeURIComponent(outside)}`));
    expect(res.status).toBe(403);
  });
});
