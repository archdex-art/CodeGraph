import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { config } from "@codegraph/config";
import { requestIsSecure } from "./session";

/**
 * A private identity for a visitor who has not signed in.
 *
 * THE PROBLEM. A repository indexed while signed out was owned by nobody (`owner_id IS NULL`),
 * which `authz.ts` treats as a bucket every visitor may read, edit and delete — source
 * included. The product needs the try-it-without-an-account path, so the previous fix was a
 * consent dialog: keep the sharing, warn about it. That works and it is still the wrong
 * default, because the honest warning ("anyone can read, edit and delete it") is a hard stop
 * for anything work-related, which is most of what anyone would point this at.
 *
 * A browser that has never signed in still has a stable, unforgeable identity available: a
 * signed cookie. An anonymous index now belongs to THAT, so it is private to the browser that
 * made it, and the shared public bucket becomes an explicit opt-in
 * (`acknowledgePublic: true`) rather than the only anonymous option.
 *
 * WHY A NEGATIVE NUMBER. `owner_id` is an INTEGER column and `ViewerId` is `number | null`;
 * every scoped query is `(owner_id IS NULL OR owner_id = ?)`. GitHub user ids are positive, so
 * taking the negative half of the range gives visitors their own namespace with no schema
 * change, no widened column, no second predicate to keep in step, and no possibility of
 * colliding with a real account. `-1` is already reserved as the "never matches" bind value in
 * `packages/persistence/src/repos.ts`, so ids start below it.
 *
 * WHAT THIS IS NOT. A cookie is a weaker identity than an account: clear it, or open another
 * browser, and those repositories are unreachable (they are not deleted — they simply have an
 * owner nobody can present any more). That is the correct trade for a trial and the UI says so;
 * it is not a substitute for signing in, and nothing about it is claimed to be.
 */

export const VISITOR_COOKIE_NAME = "cg_visitor";
/** A trial that expires while you are still reading the report is not a trial. */
const VISITOR_MAX_AGE_S = 60 * 60 * 24 * 365;

/**
 * Ids live in `[-(2^45), -2)`. Well inside `Number.MAX_SAFE_INTEGER` and inside SQLite's
 * signed-64-bit INTEGER, 45 bits of randomness, and strictly below the reserved `-1`.
 */
const ID_BITS = 45;

function signingKey(): string | null {
  return config.sessionSecret || null;
}

function sign(id: string, secret: string): string {
  return createHmac("sha256", secret).update(id).digest("base64url");
}

/** Constant-time compare; length mismatch is answered without leaking where it diverged. */
function signatureMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}

export function mintVisitorId(): number {
  // `readUIntBE` over 6 bytes gives 48 bits; mask to 45 so the value stays comfortably safe
  // and the negation cannot reach -1 or 0.
  const raw = randomBytes(6).readUIntBE(0, 6) % 2 ** ID_BITS;
  return -(raw + 2);
}

export function encodeVisitorCookie(id: number): string | null {
  const secret = signingKey();
  if (!secret) return null;
  const value = String(id);
  return `${value}.${sign(value, secret)}`;
}

/**
 * Decode a visitor cookie, or null when it is absent, unsigned, tampered with, or out of
 * range. Fails closed in every case: an unreadable visitor cookie means "anonymous", never
 * "somebody else".
 */
export function decodeVisitorCookie(raw: string | undefined): number | null {
  if (!raw) return null;
  const secret = signingKey();
  if (!secret) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = raw.slice(0, dot);
  if (!signatureMatches(raw.slice(dot + 1), sign(value, secret))) return null;
  const id = Number(value);
  // The range check is not paranoia: a signed cookie carrying a POSITIVE id would name a
  // GitHub account, and the signature only proves this server minted the string.
  if (!Number.isSafeInteger(id) || id > -2) return null;
  return id;
}

/** The visitor this request already carries, or null if it has never been given one. */
export function getVisitorId(req: NextRequest): number | null {
  return decodeVisitorCookie(req.cookies.get(VISITOR_COOKIE_NAME)?.value);
}

export function setVisitorCookie(res: NextResponse, id: number, req: NextRequest): void {
  const encoded = encodeVisitorCookie(id);
  if (!encoded) return;
  res.cookies.set(VISITOR_COOKIE_NAME, encoded, {
    httpOnly: true,
    secure: requestIsSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: VISITOR_MAX_AGE_S,
  });
}

/**
 * Whether private anonymous trials are available at all.
 *
 * Without `CG_SESSION_SECRET` there is nothing to sign with, and an unsigned visitor id is an
 * owner anyone can claim by editing a cookie — strictly worse than the shared bucket, because
 * it would LOOK private. In that configuration the old behaviour stands and the caller is told
 * why rather than being silently downgraded.
 */
export function privateTrialsAvailable(): boolean {
  return signingKey() !== null;
}
