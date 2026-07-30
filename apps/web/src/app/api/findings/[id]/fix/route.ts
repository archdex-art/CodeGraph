import { NextRequest, NextResponse } from "next/server";
import { logger } from "@codegraph/observability";
import { findingById, repoIdForFinding } from "@codegraph/persistence";
import { repoAccessDenied, viewerId } from "@/lib/authz";
import { executeFixes } from "@/lib/agents/executor";
import { fixersForRule } from "@/lib/agents/fixers";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { getRepo } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/findings/:id/fix — fix ONE finding (LLD §9.2, review item C1).
 *
 * The route this replaces in practice, `POST /api/repos/:id/fix`, takes no finding at all:
 * it ran every fixer over every file, so clicking a P0 "untrusted input reaches eval()"
 * finding produced a diff deleting `console.log` in 27 unrelated files. The ranked plan and
 * the executor were two disconnected systems the UI implied were one.
 *
 * Taking a findingId is what connects them, and it buys two things beyond a smaller diff:
 *
 *  · only the fixers that DECLARE they handle this finding's rule run (`Fixer.handles`), so
 *    an unfixable finding returns 422 instead of a plausible-looking unrelated patch;
 *  · the finding's fingerprint becomes gate 4's target, which upgrades verification from
 *    "nothing new was introduced" to "THIS finding is gone" (review C3).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Same limiter as the repo-wide route: this still clones and runs two index passes. It is
  // cheaper per call but not cheap, and a per-finding endpoint invites many more calls.
  const limited = rateLimit(`fix:${clientIp(req)}`, { capacity: 6, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many remediation requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  const finding = findingById(id);
  if (!finding) return NextResponse.json({ error: "Finding not found" }, { status: 404 });

  // Tenant check via the finding's repo, before anything is cloned or read. A findingId is
  // not itself scoped to a viewer, so resolving the owning repo is the only correct gate.
  const repoId = repoIdForFinding(id);
  if (!repoId) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  const denied = repoAccessDenied(req, repoId);
  if (denied) return denied;

  const repo = getRepo(repoId, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  if (repo.status !== "done") {
    return NextResponse.json({ error: "Repo not indexed yet" }, { status: 409 });
  }

  if (finding.status !== "open") {
    // Re-fixing a dismissed or already-fixed finding would produce a diff whose verification
    // claim is about a finding the user has already resolved.
    return NextResponse.json(
      { error: `Finding is ${finding.status}, not open`, status: finding.status },
      { status: 409 }
    );
  }

  const fixers = fixersForRule(finding.rule_id);
  if (fixers.length === 0) {
    // 422, not 500 and not an empty 200. The request was well-formed and the answer is "no
    // provider claims this rule" — which is a fact about coverage, and the honest thing to
    // return rather than running unrelated fixers to produce a non-empty diff.
    return NextResponse.json(
      {
        error: "No fixer handles this finding's rule",
        ruleId: finding.rule_id,
        autoFixable: false,
      },
      { status: 422 }
    );
  }

  try {
    const result = await executeFixes(repo, {
      file: finding.file,
      fixerIds: fixers.map((f) => f.id),
      targetFingerprint: finding.fingerprint,
    });
    return NextResponse.json({ findingId: id, ruleId: finding.rule_id, ...result });
  } catch (e) {
    // Never echo the raw exception: executor failures embed clone paths and remote URLs.
    logger.error("executor failed", { err: e, route: "findings/fix", findingId: id, repoId });
    return NextResponse.json({ error: "Remediation failed" }, { status: 500 });
  }
}
