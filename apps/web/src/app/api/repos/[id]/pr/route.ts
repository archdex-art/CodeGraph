import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/authz";
import { getRepo } from "@/lib/store";
import { viewerId } from "@/lib/authz";
import { diffRange, gitCommitsForRoot, isGitRepo } from "@codegraph/vcs";
import { analysePr } from "@/lib/printel/analyse";
import { parseUnifiedDiff } from "@/lib/printel/diff";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * History window the reviewer recommendation is drawn from. Six months, matching `gitSignals`
 * and `gitOwnership`, so "recently active" means the same thing on every surface.
 */
const WINDOW_DAYS = 180;

/**
 * A git ref supplied by a caller.
 *
 * Deliberately NARROWER than git's own ref grammar. `git diff` takes options and refs in the
 * same argv position, so a value beginning with `-` is an OPTION — `--output=/path` writes a
 * file, `--upload-pack=cmd` runs one on a fetch. `packages/vcs`'s `assertRefArg` rejects the
 * leading dash at the choke point, and this rejects it earlier and rejects more: a ref here can
 * only be a branch, tag or hash-shaped name, because nothing this route legitimately serves
 * needs `HEAD@{2}` or a pathspec. Whitelist, not blacklist, for the reason the timeline route
 * validates its hash the same way — sanitising downstream is where these get missed.
 */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
function isRef(value: string | null): value is string {
  // `..` would turn one ref into a range and `.lock`/trailing-dot are invalid to git anyway.
  return value !== null && REF.test(value) && !value.includes("..");
}

// GET /api/repos/:id/pr?base=<ref>&head=<ref>
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { denied, ws } = requireWorkspace(req, id);
  if (denied) return denied;
  if (!(await isGitRepo(ws.dir))) {
    return NextResponse.json({ error: "Not a git workspace" }, { status: 409 });
  }

  const { searchParams } = new URL(req.url);
  const base = searchParams.get("base");
  const head = searchParams.get("head") ?? "HEAD";
  if (!isRef(base) || !isRef(head)) {
    return NextResponse.json(
      { error: "Missing or malformed base/head ref" },
      { status: 400 },
    );
  }

  // The graph and API surface come from the stored index, not from a fresh one: analysing a
  // diff must not cost a full re-index per request. The consequence — symbol spans are the
  // CURRENT tree's, not `head`'s — is documented on `analysePr` and surfaced to the caller
  // below rather than hidden.
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "done") {
    return NextResponse.json({ error: "Repo not indexed yet" }, { status: 409 });
  }

  try {
    const raw = await diffRange(ws.dir, base, head);
    const changed = parseUnifiedDiff(raw);
    const commits = gitCommitsForRoot(ws.dir, { since: `${WINDOW_DAYS}.days.ago` });

    const analysis = analysePr({
      base,
      head,
      changed,
      graph: repo.symbolGraph,
      apiSurface: repo.apiSurface,
      commits,
      windowDays: WINDOW_DAYS,
      // The indexed file list, for test discovery. `viz` carries every file the scan kept,
      // which is the same set the symbol graph was built from.
      files: repo.viz.nodes.filter((n) => n.kind === "file").map((n) => ({ rel: n.id })),
    });

    return NextResponse.json({
      ...analysis,
      // Named, not implied: the graph this was joined against is the last index, so a PR that
      // moves code is matched against where that code is now.
      analysedAgainst: { indexedAt: repo.finishedAt, note: "symbol spans are from the latest index, not from `head`" },
    });
  } catch (e) {
    // Ref resolution failures are the common case (a branch that does not exist locally),
    // but git says so as `Command failed: git -C /app/data/workspaces/<uuid> diff …`, which
    // hands every repo viewer the absolute workspace path and the internal repo UUID for
    // the sake of one word. The actionable half is restated here without them (F023).
    logger.warn("pr diff failed", { repoId: id, base, head, error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { error: "Could not diff those refs. Check that both the base and the head exist in this workspace." },
      { status: 400 },
    );
  }
}
