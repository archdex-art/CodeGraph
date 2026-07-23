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
import { getSession } from "./session";
import { getRepoOwnerId, getWorkspaceDir } from "./store";
import type { SourceType } from "./types";

/** Current viewer's userId for scoping list queries, or `null` if signed out. */
export function viewerId(req: NextRequest): number | null {
  return getSession(req)?.userId ?? null;
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
 * Combines the ownership check with workspace-directory resolution — every
 * route that touches a repo's on-disk workspace (fs, git, search, timeline)
 * needs both, in this order. `denied` is a `NextResponse` to return
 * immediately when set; otherwise `ws` is the resolved workspace.
 */
export function requireWorkspace(
  req: NextRequest,
  id: string
): { denied: NextResponse; ws?: undefined } | { denied?: undefined; ws: { dir: string; sourceType: SourceType } } {
  const denied = repoAccessDenied(req, id);
  if (denied) return { denied };
  const ws = getWorkspaceDir(id);
  if (!ws) return { denied: NextResponse.json({ error: "Workspace not ready" }, { status: 404 }) };
  return { ws };
}
