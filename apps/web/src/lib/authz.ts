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
import { config } from "@codegraph/config";
import { viewerId as brandViewerId, type ViewerId } from "@codegraph/core-domain";
import { getSession } from "./session";
import { getVisitorId } from "./visitor";
import { getRepoOwnerId, getWorkspaceDir } from "./store";
import { hasWorkingTree, materialiseWorkingTree } from "@codegraph/vcs";
import { logger } from "@codegraph/observability";

/**
<<<<<<< HEAD
 * May this deployment create repos in the shared public bucket at all?
 *
 * Reads scope correctly already — a signed-in owner's repos are private and every
 * other viewer gets a 404. The hole was never enforcement, it was that nobody was
 * TOLD: indexing signed out writes `owner_id IS NULL`, and that bucket is
 * world-readable and world-mutable, source contents included.
 *
 * So the answer is consent, not prohibition. This stays a capability an operator can
 * switch off, but it defaults on; what actually protects the user is that the route
 * below refuses an anonymous index unless the caller states it understands.
 */
export function anonymousIndexingAllowed(): boolean {
  return config.allowAnonymousIndexing;
}

export const ANONYMOUS_INDEXING_DISABLED_MESSAGE =
  "This deployment requires you to sign in with GitHub before indexing a repository.";

/**
 * An anonymous index must SAY it accepts the consequence.
 *
 * The consent lives in the request body, not in a UI-only dialog, because the dialog
 * is trivially bypassed by posting to the endpoint directly — and a caller that has
 * never heard of the flag is exactly the caller who did not mean to publish. Omitting
 * it fails closed with an explanation instead of quietly creating a public repo.
 */
export const ANONYMOUS_CONSENT_MESSAGE =
  "Indexing without signing in puts this repository in a shared bucket that every visitor to this deployment can read, edit and delete — including its source. Sign in with GitHub to keep it private, or re-send with `acknowledgePublic: true` to continue anyway.";

/**
 * Current viewer for scoping persistence reads, or `null` when signed out.
=======
 * Current viewer for scoping persistence reads, or `null` when this request carries no
 * identity at all.
 *
 * Two kinds of identity, in priority order. A GitHub session is the strong one. Failing that,
 * a signed visitor cookie (`lib/visitor.ts`) names the browser that indexed a repository
 * without signing in — its repositories are private to it, which is what makes the trial path
 * usable for code somebody actually cares about. A request with neither sees only the shared
 * public bucket, exactly as before.
>>>>>>> 14271d6 (feat(vcs): read a repository out of git instead of off a checkout)
 *
 * Returns the branded `ViewerId` so it cannot be confused with any other numeric
 * id at a call site, and so a repository read cannot be handed a repo id by
 * mistake (LLD §2, §8).
 */
export function viewerId(req: NextRequest): ViewerId {
  return brandViewerId(getSession(req)?.userId ?? getVisitorId(req));
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
 * Access check + workspace resolution as ONE step, because doing them separately is what
 * caused a cross-tenant leak.
 *
 * Ported from `main` (PR #25). The `repoAccessDenied()` then `getWorkspaceDir()`-or-404
 * sequence was hand-copied across 8 call sites in 4 route files, and a hand-copied access
 * check is one someone eventually copies incompletely — which is exactly the Phase 0.6
 * cross-tenant leak. Collapsing it means a route cannot obtain a workspace directory WITHOUT
 * having passed the tenant check, so the unsafe order stops being expressible.
 *
 * The 404-for-a-not-ready-workspace is deliberate and matches `repoAccessDenied`: a caller who
 * may not see this repo and a caller whose clone has not finished get the same answer, so
 * neither response distinguishes "exists but not yours" from "not there".
 *
 * Returns a discriminated union so `if (denied) return denied;` narrows `ws` to defined —
 * the compiler enforces the check at every call site rather than trusting the caller to look.
 */
/** Whatever `getWorkspaceDir` returns when it succeeds — derived so the two cannot drift. */
type Workspace = NonNullable<ReturnType<typeof getWorkspaceDir>>;

export function requireWorkspace(
  req: NextRequest,
  id: string,
  opts?: {
    /**
     * Whether this route reads or writes real FILES, as opposed to only talking to `.git`.
     *
     * Defaults to true, and the default is the safe direction on purpose: a route that needs
     * files and forgets to say so gets a correct (if slower) answer, whereas one that opts out
     * wrongly would see an empty directory and report a repository as having no content.
     */
    readonly files?: boolean;
  },
):
  | { denied: NextResponse; ws?: undefined }
  | { denied?: undefined; ws: Workspace } {
  const denied = repoAccessDenied(req, id);
  if (denied) return { denied };
  const ws = getWorkspaceDir(id);
  if (!ws) return { denied: NextResponse.json({ error: "Workspace not ready" }, { status: 404 }) };

  /**
   * The working tree is created HERE, on first use, not at index time.
   *
   * Analysis reads its files out of git (`gitTreeFiles` / `readBlobs`), so a repository is
   * cloned with `--no-checkout` and the checkout is pure cost until something wants real
   * paths. Measured on `microsoft/TypeScript`: the git objects are 41 MB and the checkout is
   * 655 MB. A visitor who indexes a repository and looks at the graph never touches this
   * function, and never pays the 614 MB.
   *
   * This is the one place worth doing it because it is the one place every file-touching
   * route already funnels through — the access check made it a choke point, and that makes it
   * the choke point for materialisation too. `hasWorkingTree` is a single `git ls-tree` plus
   * one `existsSync`, so the common case (already checked out, or a local folder that was
   * never a clone) costs nothing measurable.
   */
  if (opts?.files !== false && !hasWorkingTree(ws.dir)) {
    try {
      materialiseWorkingTree(ws.dir);
    } catch (e) {
      logger.warn("could not materialise working tree", { repoId: id, err: e instanceof Error ? e.message : String(e) });
      return { denied: NextResponse.json({ error: "Workspace files are not available" }, { status: 409 }) };
    }
  }
  return { ws };
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
