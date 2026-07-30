// Per-repo access control for the multi-tenant repo store.
//
// Model (matches product decision: "anonymous = shared public bucket,
// GitHub accounts = private"):
//   - A repo indexed while signed out (owner_id IS NULL) lands in a shared
//     public bucket — visible/mutable by anyone, same as pre-auth behavior.
//   - A repo indexed while signed in with GitHub (owner_id = session.userId)
//     is private to that account. Every other viewer — including other
//     signed-in accounts and anonymous visitors — gets a 404, not a 403, so
//     a private repo's mere existence isn't leaked to anyone but its owner.
import { NextRequest, NextResponse } from "next/server";
import { viewerId as brandViewerId, type ViewerId } from "@codegraph/core-domain";
import { getSession } from "./session";
import { getRepoOwnerId } from "./store";

/**
 * Current viewer for scoping persistence reads, or `null` when signed out.
 *
 * Returns the branded `ViewerId` so it cannot be confused with any other numeric
 * id at a call site, and so a repository read cannot be handed a repo id by
 * mistake (LLD §2, §8).
 */
export function viewerId(req: NextRequest): ViewerId {
  return brandViewerId(getSession(req)?.userId ?? null);
}

/**
 * Returns a 404 `NextResponse` if `req` may NOT act on repo `id` (doesn't
 * exist, or is privately owned by someone else), or `null` if access is
 * allowed — call sites should `return` the non-null result immediately.
 */
export function repoAccessDenied(req: NextRequest, id: string): NextResponse | null {
  const ownerId = getRepoOwnerId(id);
  if (ownerId === undefined) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (ownerId === null) return null; // public bucket — open to everyone
  return viewerId(req) === ownerId ? null : NextResponse.json({ error: "Repo not found" }, { status: 404 });
}

/**
 * The GitHub credential this request may PUBLISH with (push a branch, open a
 * PR), or `undefined` if it may not publish at all.
 *
 * Reading a repo and writing to its remote are different privileges, so this
 * is deliberately stricter than `repoAccessDenied`:
 *
 *   - The token comes from the encrypted session cookie and nowhere else. It
 *     was previously read from the REQUEST BODY, which let the server push
 *     using a credential it had never verified belonged to the caller.
 *   - A repo in the shared public bucket (owner_id IS NULL) is readable and
 *     fixable by anyone, but was indexed by an anonymous visitor and has no
 *     established relationship to whoever is signed in now. Pushing a branch
 *     to it on their behalf would be acting on a repository they never
 *     claimed, so publishing requires OWNERSHIP, not merely access.
 *
 * Callers denied a credential still get the full verified diff as a draft.
 *
 * CURRENTLY UNCALLED, deliberately. Publishing became opt-in behind `PublishConsent`
 * (review C4), and no route constructs that object yet — so nothing publishes as shipped and
 * this has no caller. It is kept rather than deleted because the OWNERSHIP rule above is the
 * non-obvious half of P0's B8 fix, and re-deriving it later is exactly how a security
 * property gets quietly weakened to "has a token". `POST /api/fixes/:candidateId/publish`
 * (LLD §7.3) is what will call it.
 */
export function publishCredential(req: NextRequest, repoId: string): string | undefined {
  const session = getSession(req);
  if (!session) return undefined;
  const ownerId = getRepoOwnerId(repoId);
  if (ownerId === null || ownerId === undefined) return undefined;
  return ownerId === session.userId ? session.accessToken : undefined;
}
