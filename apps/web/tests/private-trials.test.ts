import { describe, expect, it, beforeAll } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  VISITOR_COOKIE_NAME,
  decodeVisitorCookie,
  encodeVisitorCookie,
  getVisitorId,
  mintVisitorId,
  privateTrialsAvailable,
  setVisitorCookie,
} from "@/lib/visitor";
import { viewerId } from "@/lib/authz";

/**
 * A repository indexed while signed out used to be owned by nobody, which the access model
 * reads as "everybody" — the shared public bucket. It is now owned by a signed visitor
 * cookie, so a trial is private to the browser that ran it. The properties that make that
 * safe rather than merely different are all here: the id cannot be forged, it cannot name a
 * GitHub account, and an unreadable cookie degrades to anonymous rather than to somebody else.
 */

beforeAll(() => {
  process.env.CG_SESSION_SECRET = process.env.CG_SESSION_SECRET || "test-secret-for-private-trials";
});

function reqWith(cookie?: string): NextRequest {
  return new NextRequest("http://localhost/api/index", {
    headers: cookie ? { cookie: `${VISITOR_COOKIE_NAME}=${cookie}` } : {},
  });
}

describe("visitor identity", () => {
  it("is available once a session secret exists", () => {
    expect(privateTrialsAvailable()).toBe(true);
  });

  it("round-trips a minted id through the cookie", () => {
    const id = mintVisitorId();
    const encoded = encodeVisitorCookie(id)!;
    expect(decodeVisitorCookie(encoded)).toBe(id);
    expect(getVisitorId(reqWith(encoded))).toBe(id);
  });

  it("mints ids in the negative namespace, clear of GitHub's and of the reserved -1", () => {
    for (let i = 0; i < 200; i++) {
      const id = mintVisitorId();
      expect(id).toBeLessThan(-1);
      expect(Number.isSafeInteger(id)).toBe(true);
    }
    // Distinct browsers must not collide into one another's repositories.
    const minted = new Set(Array.from({ length: 500 }, () => mintVisitorId()));
    expect(minted.size).toBe(500);
  });

  it("rejects a tampered id, so a visitor cannot claim another visitor's repos", () => {
    const victim = mintVisitorId();
    const encoded = encodeVisitorCookie(victim)!;
    const signature = encoded.slice(encoded.lastIndexOf(".") + 1);
    const attacker = `${victim - 1}.${signature}`;
    expect(decodeVisitorCookie(attacker)).toBeNull();
    expect(getVisitorId(reqWith(attacker))).toBeNull();
  });

  it("rejects a POSITIVE id even when correctly signed — that would name a GitHub account", () => {
    // The signature only proves this server minted the string; the range check is what stops
    // a value that would be compared against a real account's owner_id.
    const forged = encodeVisitorCookie(12345)!;
    expect(decodeVisitorCookie(forged)).toBeNull();
  });

  it("rejects an unsigned or malformed cookie", () => {
    expect(decodeVisitorCookie("-42")).toBeNull();
    expect(decodeVisitorCookie("-42.")).toBeNull();
    expect(decodeVisitorCookie(".sig")).toBeNull();
    expect(decodeVisitorCookie("")).toBeNull();
    expect(decodeVisitorCookie(undefined)).toBeNull();
  });

  it("sets an httpOnly, SameSite=Lax cookie scoped to the whole site", () => {
    const res = NextResponse.json({});
    const id = mintVisitorId();
    setVisitorCookie(res, id, reqWith());
    const cookie = res.cookies.get(VISITOR_COOKIE_NAME)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/");
    expect(decodeVisitorCookie(cookie.value)).toBe(id);
  });
});

describe("viewerId", () => {
  it("is the visitor when there is no session", () => {
    const id = mintVisitorId();
    expect(viewerId(reqWith(encodeVisitorCookie(id)!))).toBe(id);
  });

  it("is null when the request carries no identity at all — the public bucket, unchanged", () => {
    expect(viewerId(reqWith())).toBeNull();
  });

  it("ignores a visitor cookie that does not verify", () => {
    expect(viewerId(reqWith("-99.not-a-signature"))).toBeNull();
  });
});
