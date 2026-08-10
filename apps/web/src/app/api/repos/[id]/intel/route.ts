import { NextRequest, NextResponse } from "next/server";
import { getRepo } from "@/lib/store";
import { repoAccessDenied, viewerId } from "@/lib/authz";
import { QueryEngine, blastRadius, isTestFile, rankUntestedHubs, untestedHubs } from "@/lib/codeintel/query";
import { buildContext } from "@/lib/codeintel/context";
import { ask, endpointsAffectedBy, unauthenticatedSinkPaths } from "@codegraph/core-graph";
import { askCorpus } from "@/lib/codeintel/askCorpus";
import { logger } from "@codegraph/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/repos/:id/intel?op=search&q=... | callers | callees | impact | blast | untested
//   | context | cycles | deadcode | hubs | endpoints | flows | api-impact | unauth-paths | taint
//   | ask
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = repoAccessDenied(req, id);
  if (denied) return denied;
  const repo = getRepo(id, viewerId(req));
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });

  const g = repo.symbolGraph;
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "search";
  const q = url.searchParams.get("q") || "";
  const sym = url.searchParams.get("symbol") || "";
  const qe = new QueryEngine(g);

  switch (op) {
    case "search":
      return NextResponse.json({ results: qe.search(q, 40) });
    case "callers":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.callers(sym) });
    case "callees":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.callees(sym) });
    case "members":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.members(sym) });
    case "impact":
      return NextResponse.json({ symbol: qe.get(sym), results: qe.impact(sym, 3) });
    case "blast": {
      // Four hops rather than impact()'s three: the fourth is usually where a route
      // handler or a test finally shows up, which is the answer people came for.
      const depth = Math.min(6, Math.max(1, Number(url.searchParams.get("depth")) || 4));
      return NextResponse.json(blastRadius(qe, sym, depth));
    }
    case "untested":
      return NextResponse.json({ results: rankUntestedHubs(untestedHubs(qe)) });
    case "cycles":
      return NextResponse.json({ cycles: qe.cycles() });
    case "deadcode":
      return NextResponse.json({ results: qe.deadCode().slice(0, 100) });
    case "hubs":
      return NextResponse.json({ results: qe.hubs(20) });
    case "context":
      return NextResponse.json(buildContext(g, q));
    /**
     * The API surface and taint report are computed at INDEX time and stored on the repo, so
     * these ops read rather than recompute. `undefined` means the row predates the analysis;
     * that is answered as a 409 rather than as an empty result, because "nothing found" and
     * "never looked" are different answers and a caller cannot tell them apart from `[]`.
     */
    case "endpoints": {
      if (!repo.apiSurface) return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
      return NextResponse.json({ endpoints: repo.apiSurface.endpoints, truncated: repo.apiSurface.truncated });
    }
    case "flows": {
      if (!repo.apiSurface) return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
      return NextResponse.json({ flows: repo.apiSurface.flows, truncated: repo.apiSurface.truncated });
    }
    case "api-impact": {
      if (!repo.apiSurface) return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
      if (!sym) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      return NextResponse.json({ endpoints: endpointsAffectedBy(repo.apiSurface, g, sym) });
    }
    case "unauth-paths": {
      if (!repo.apiSurface) return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
      // Only endpoints whose handler RESOLVED and carries no guard. An unresolved handler is
      // `authenticated: null` and is excluded, so an analysis gap never becomes an accusation.
      return NextResponse.json({ paths: unauthenticatedSinkPaths(repo.apiSurface) });
    }
    case "taint": {
      if (!repo.taint) return NextResponse.json({ error: "Not analysed — re-index this repo" }, { status: 409 });
      return NextResponse.json(repo.taint);
    }
    /**
     * Deterministic natural-language querying.
     *
     * The compiler runs against the SAME graph, API surface and test predicate the other ops
     * use, so an answer here cannot contradict the Impact page or the Agents tab. It never
     * reaches the network and consults no model: the failure mode is a refusal, returned as a
     * 200 with `ok: false` because "I cannot answer that" is a successful, meaningful response
     * to a well-formed request, not an HTTP error.
     */
    case "ask": {
      if (!q.trim()) return NextResponse.json({ error: "Missing question" }, { status: 400 });
      // Bounded so a pathological question cannot drive the tokeniser or the edit-distance
      // sweep across a large graph; the longest supported form is far below this.
      if (q.length > 300) return NextResponse.json({ error: "Question too long" }, { status: 400 });
      const answer = ask(q, askCorpus(repo), isTestFile);
      /**
       * A refusal is the signal that grows the vocabulary.
       *
       * The synonym dictionary is hand-written, so it only ever contains the words its author
       * thought of. Measured against forty-one questions phrased by someone else, four failed
       * on missing vocabulary alone - including `blast radius`, which is the product's OWN
       * term, printed on the Impact page. Guessing at the gaps is what produced them; this
       * records the actual misses so the next dictionary entry is evidence-led.
       *
       * Only UNCLASSIFIED questions are logged, and only the question text. A classified
       * question needs no help, and the text is what the user typed into a box they know is a
       * query - the same expectation as any server access log. No repo id, no viewer id: this
       * is for reading the vocabulary gap in aggregate, not for tracing a person.
       */
      if (!answer.ok && answer.reason === "unclassified") {
        logger.info("ask: unclassified question", { question: q });
      }
      return NextResponse.json(answer);
    }
    default:
      return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
  }
}
