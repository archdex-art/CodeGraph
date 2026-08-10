import { NextRequest, NextResponse } from "next/server";
import { repoAccessDenied, requireWorkspace, viewerId } from "@/lib/authz";
import { getRepo } from "@/lib/store";
import { familiarity, gitCommitsForRoot, isGitRepo, recommendReviewers } from "@codegraph/vcs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Matches `gitOwnership`'s own window, so "recently active" means one thing everywhere. */
const WINDOW_DAYS = 180;

/** Changed files a reviewer query will weigh. A larger list is a rename sweep. */
const MAX_FILES = 50;

/**
 * GET /api/repos/:id/ownership?op=summary | file&path=… | reviewers&files=a,b | familiarity&author=…
 *
 * `summary` and `file` read the report computed at index time; `reviewers` and `familiarity`
 * need the commit log, because both are questions about a set the caller supplies rather than
 * about the repository as a whole, and precomputing every possible answer is not a thing.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") || "summary";

  if (op === "summary" || op === "file") {
    // ABSENT is answered as 409, not as an empty report. A repository indexed before ownership
    // analysis existed has no data; saying "no owners" would be a claim we cannot support.
    if (!repo.ownership) {
      return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
    }
    if (op === "summary") {
      return NextResponse.json({
        authors: repo.ownership.authors,
        windowDays: repo.ownership.windowDays,
        commitsAnalysed: repo.ownership.commitsAnalysed,
        truncated: repo.ownership.truncated,
        // The stale/orphaned subset, which is the actionable half of the report.
        stale: repo.ownership.files.filter((f) => f.orphaned).slice(0, 100),
      });
    }
    const path = searchParams.get("path");
    if (!path) return NextResponse.json({ error: "Missing path" }, { status: 400 });
    const entry = repo.ownership.files.find((f) => f.path === path);
    if (!entry) return NextResponse.json({ error: "No ownership recorded for that path" }, { status: 404 });
    const symbols = repo.ownership.symbols.filter((s) => s.symbolId.startsWith(`${path}#`));
    return NextResponse.json({ file: entry, symbols });
  }

  // The remaining ops read git, so they need the workspace and the same ownership check again
  // — `requireWorkspace` resolves and authorises in one step, which is what stops a handler
  // obtaining a directory it was not allowed to open.
  const { denied: wsDenied, ws } = requireWorkspace(req, id);
  if (wsDenied) return wsDenied;
  if (!(await isGitRepo(ws.dir))) {
    return NextResponse.json({ error: "Not a git workspace" }, { status: 409 });
  }
  const commits = gitCommitsForRoot(ws.dir, { since: `${WINDOW_DAYS}.days.ago` });

  if (op === "reviewers") {
    const files = (searchParams.get("files") ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, MAX_FILES);
    if (files.length === 0) return NextResponse.json({ error: "Missing files" }, { status: 400 });
    return NextResponse.json({
      reviewers: recommendReviewers(commits, files, { windowDays: WINDOW_DAYS }),
      // Stated so an empty list is readable: no history means no recommendation, which is a
      // different answer from "nobody is a good reviewer".
      commitsAnalysed: commits.length,
    });
  }

  if (op === "familiarity") {
    const author = searchParams.get("author");
    if (!author) return NextResponse.json({ error: "Missing author" }, { status: 400 });
    return NextResponse.json(familiarity(commits, author));
  }

  return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
}
