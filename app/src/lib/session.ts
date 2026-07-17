// Stateless, encrypted session for GitHub sign-in — no server-side session
// table. The GitHub access token lives ONLY inside an AES-256-GCM-encrypted,
// httpOnly cookie: unreadable by client JS (httpOnly), unforgeable and
// untamperable without CG_SESSION_SECRET (GCM auth tag), and never persisted
// to disk/SQLite. /api/auth/me deliberately never echoes accessToken back to
// the client — only login/name/avatar.
import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

export const SESSION_COOKIE_NAME = "cg_session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

export interface SessionPayload {
  userId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  accessToken: string;
  issuedAt: number;
}

function sessionKey(): Buffer {
  const secret = process.env.CG_SESSION_SECRET;
  if (!secret) throw new Error("CG_SESSION_SECRET is not set");
  return createHash("sha256").update(secret).digest(); // 32 bytes, fits AES-256
}

export function encryptSession(payload: SessionPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptSession(cookieValue: string): SessionPayload | null {
  try {
    const buf = Buffer.from(cookieValue, "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const payload = JSON.parse(dec.toString("utf8")) as SessionPayload;
    // F012: enforce expiry server-side. The GCM tag proves the cookie wasn't
    // forged, but a valid-forever cookie copied out of the browser (backup,
    // log capture, proxy/cache persistence) would otherwise be accepted
    // indefinitely regardless of the client-enforced Max-Age.
    if (typeof payload.issuedAt !== "number" || Date.now() - payload.issuedAt > SESSION_MAX_AGE_S * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null; // tampered, wrong key, expired format, CG_SESSION_SECRET unset — always fail closed
  }
}

// F013: derive the cookie `Secure` flag from whether the connection is
// actually TLS, not from NODE_ENV (a build-mode flag that can diverge from
// the real transport behind a proxy). `CG_FORCE_SECURE_COOKIES` overrides
// explicitly; otherwise trust `x-forwarded-proto` (Render/any reverse proxy)
// then the request's own scheme.
export function requestIsSecure(req: NextRequest): boolean {
  if (process.env.CG_FORCE_SECURE_COOKIES === "true") return true;
  if (process.env.CG_FORCE_SECURE_COOKIES === "false") return false;
  const xfProto = req.headers.get("x-forwarded-proto");
  if (xfProto) return xfProto.split(",")[0]!.trim() === "https";
  return req.nextUrl.protocol === "https:";
}

/** Read + decrypt the session cookie from an incoming request, or null if absent/invalid. */
export function getSession(req: NextRequest): SessionPayload | null {
  const raw = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  return decryptSession(raw);
}

export function setSessionCookie(res: NextResponse, payload: SessionPayload, req?: NextRequest): void {
  res.cookies.set(SESSION_COOKIE_NAME, encryptSession(payload), {
    httpOnly: true,
    secure: req ? requestIsSecure(req) : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.delete(SESSION_COOKIE_NAME);
}

/** Short-lived cookie options for the OAuth CSRF `state` + return-path values. */
export function oauthTransitCookieOptions(req?: NextRequest) {
  return { httpOnly: true, secure: req ? requestIsSecure(req) : process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 600 };
}
