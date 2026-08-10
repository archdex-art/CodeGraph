import type { RepoDetail } from "../types";
import { QueryEngine, untestedHubs } from "../codeintel/query";
import { plural } from "../plural";
import type { AgentId, Finding } from "./types";

// Shared context passed to every specialist.
export interface AgentContext {
  repo: RepoDetail;
  qe: QueryEngine;
}

export interface Specialist {
  id: AgentId;
  label: string;
  run(ctx: AgentContext): Finding[];
}

let seq = 0;
function mk(
  agent: AgentId,
  f: Omit<Finding, "id" | "agent">
): Finding {
  return { id: `f${seq++}`, agent, ...f };
}

// ---- Security ----
const security: Specialist = {
  id: "security",
  label: "Security",
  run({ repo, qe }) {
    const base = repo.issues
      .filter((i) => i.dimension === "security")
      .slice(0, 40)
      .map((i) =>
        mk("security", {
          severity: i.severity,
          confidence: i.confidence ?? (i.severity >= 4 ? 0.9 : 0.65),
          title: i.title,
          detail: `Security-sensitive pattern on a path with blast radius ${i.blastRadius}. Exploitable code reachable from ${plural(i.blastRadius, "caller")} warrants review.`,
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          churn: i.churn,
          suggestedFix: fixForSecurity(i.title),
          effort: i.severity >= 4 ? "M" : "S",
        })
      );
    /**
     * The real analysis when the index produced one, the reachability approximation when it
     * did not — and never both, or the same flow would be reported twice under two different
     * confidences. Absent means the row predates `analyseTaint`; a present-but-empty report
     * means it ran and found nothing, which must NOT fall back to the weaker check and
     * manufacture findings the better analysis rejected.
     */
    const taint = repo.taint ? taintReportFindings(repo) : taintFindings(repo, qe);
    return [...base, ...taint];
  },
};

/**
 * Findings from the REAL inter-procedural analysis, when the index produced one.
 *
 * `analyseTaint` follows the value — argument index to parameter index across resolved call
 * edges — so a path here is a claim about data. The fallback below is reachability: "a handler
 * can reach a function that contains a flagged line", which says nothing about whether the
 * untrusted value arrives there. Preferring the real one when it exists is the whole reason
 * the index pays for it.
 *
 * A `sanitized` path is DROPPED from the finding list rather than reported at low severity: the
 * report keeps it (see `/intel?op=taint`) so a reader can see the defence, but a specialist
 * exists to name things to fix, and a guarded path is not one.
 */
function taintReportFindings(repo: RepoDetail): Finding[] {
  const report = repo.taint;
  if (!report) return [];
  const out: Finding[] = [];
  for (const path of report.paths) {
    if (path.sanitized) continue;
    if (out.length >= 10) break;
    const hops = Math.max(1, path.hops.length - 1);
    out.push(
      mk("security", {
        // Severity follows confidence rather than a constant: a 4-hop heuristic chain and a
        // 1-hop type-resolved one are not the same claim and must not read as one.
        severity: path.confidence >= 0.7 ? 5 : 4,
        confidence: path.confidence,
        title: `Untrusted input reaches ${path.sink.rule.replace(/-/g, " ")}`,
        detail:
          `${path.source.evidence} flows to ${path.sink.evidence} through ${hops} call${hops > 1 ? "s" : ""}` +
          ` (${path.hops.map((h) => h.name).join(" → ")}). Value-tracked across call boundaries, not just reachability.`,
        file: path.source.file,
        line: path.source.line,
        symbol: path.source.symbolId,
        blastRadius: path.hops.length,
        churn: repo.churnByFile?.[path.source.file] ?? 1,
        suggestedFix: `Validate or encode the value before it reaches ${path.sink.file}:${path.sink.line}.`,
        effort: "M",
      }),
    );
  }
  return out;
}

// ---- Shallow taint reachability ----
// Source: any callable whose signature suggests it receives raw request/user input
// (matches common Express/Next.js/Fastify handler shapes: `(req, res)`, `(request: Request)`).
// Sink: the enclosing function of an existing security-flagged line (eval, exec, SQL, HTML
// injection, ...). A source reaching a sink through 1+ real call-graph hops is materially
// stronger evidence than "eval() appears somewhere in this file" -- it shows the exploitable
// code is actually wired to attacker-controlled input, not just theoretically risky in isolation.
const SOURCE_PARAM_RE = /\(\s*(?:req|request)\b/i;

function taintFindings(repo: RepoDetail, qe: QueryEngine): Finding[] {
  const callableKinds = new Set(["function", "method", "component"]);
  const sources = repo.symbolGraph.symbols.filter(
    (s) => callableKinds.has(s.kind) && SOURCE_PARAM_RE.test(s.signature)
  );
  const sinkIssues = repo.issues.filter((i) => i.dimension === "security");
  if (sources.length === 0 || sinkIssues.length === 0) return [];

  const out: Finding[] = [];
  const seenPairs = new Set<string>();
  for (const source of sources) {
    const reachable = qe.reachableCallees(source.id, 3);
    if (!reachable.length) continue;
    const hopsById = new Map(reachable.map((r) => [r.symbol.id, r.hops]));

    for (const issue of sinkIssues) {
      const sinkSymbol = qe.symbolAt(issue.file, issue.line);
      if (!sinkSymbol || sinkSymbol.id === source.id) continue;
      const hops = hopsById.get(sinkSymbol.id);
      if (hops === undefined) continue; // not reachable from this source within the depth bound

      const key = `${source.id}->${sinkSymbol.id}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      out.push(
        mk("security", {
          severity: Math.min(5, issue.severity + 1), // graph-verified reachability raises severity
          confidence: 0.9,
          title: `Untrusted input reaches ${issue.title.toLowerCase()}`,
          detail: `${source.name}(...) receives request/user input and reaches ${sinkSymbol.name}(), which contains "${issue.title}", via ${hops} call${hops > 1 ? "s" : ""}. Graph-verified path, not just file co-occurrence.`,
          file: source.file,
          line: source.line,
          symbol: source.id,
          blastRadius: issue.blastRadius,
          churn: repo.churnByFile?.[source.file] ?? 1,
          suggestedFix: `Validate/sanitize input in ${source.name} before it reaches ${sinkSymbol.name}. ${fixForSecurity(issue.title)}`,
          effort: "M",
        })
      );
      if (out.length >= 10) return out;
    }
  }
  return out;
}

function fixForSecurity(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("eval")) return "Replace eval() with a safe parser or explicit dispatch table; eval enables arbitrary code execution.";
  if (t.includes("secret")) return "Move the hardcoded secret to an environment variable / secrets manager and rotate the exposed value.";
  if (t.includes("sql")) return "Use parameterized queries / prepared statements instead of string concatenation to prevent SQL injection.";
  if (t.includes("html")) return "Sanitize input before rendering, or avoid raw HTML injection; use safe templating.";
  if (t.includes("shell") || t.includes("process")) return "Validate/allowlist arguments and avoid passing untrusted input to shell execution.";
  return "Review this security-sensitive code path and add input validation.";
}

// ---- Performance ----
const performance: Specialist = {
  id: "performance",
  label: "Performance",
  run({ repo, qe }) {
    const out: Finding[] = [];
    // Hub symbols with many callers = hot paths worth optimizing.
    for (const s of qe.hubs(8)) {
      if (s.fanIn < 3) continue;
      out.push(
        mk("performance", {
          severity: Math.min(4, 2 + Math.floor(s.fanIn / 8)),
          confidence: s.fanIn > 20 ? 0.8 : 0.6, // higher fan-in = more certain bottleneck
          title: `Hot path: ${s.name} (${s.fanIn} callers)`,
          detail: `${s.name} is called from ${s.fanIn} sites. Optimizations here (caching, reduced allocation, memoization) have amplified impact.`,
          file: s.file,
          line: s.line,
          symbol: s.id,
          blastRadius: s.fanIn,
          churn: repo.churnByFile?.[s.file] ?? 1,
          suggestedFix: `Profile ${s.name}; consider memoization or reducing per-call work since it sits on a high-traffic path.`,
          effort: "M",
        })
      );
    }
    return out;
  },
};

// ---- Refactor (complexity / god files) ----
const refactor: Specialist = {
  id: "refactor",
  label: "Refactor",
  run({ repo, qe }) {
    const findings: Finding[] = [];
    
    // 1. Base maintainability issues from indexer (e.g. God files, TODO markers)
    findings.push(...repo.issues
      .filter((i) => i.dimension === "maintainability" && /large file/i.test(i.title))
      .slice(0, 10)
      .map((i) =>
        mk("refactor", {
          severity: i.severity,
          confidence: i.confidence ?? 0.8,
          title: i.title,
          detail: `Large modules are hard to test and reason about, and raise merge-conflict risk. Blast radius ${i.blastRadius}.`,
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          churn: i.churn,
          suggestedFix: "Split this file along cohesive responsibilities into smaller modules; extract pure helpers.",
          effort: "L",
        })
      ));

    // 2. High cyclomatic complexity functions
    const complexFuncs = qe.hubs(100).filter(s => (s.complexity ?? 0) > 15);
    // Sort by complexity descending
    complexFuncs.sort((a, b) => (b.complexity ?? 0) - (a.complexity ?? 0));
    
    for (const s of complexFuncs.slice(0, 15)) {
      findings.push(
        mk("refactor", {
          severity: Math.min(4, 1 + Math.floor(s.complexity! / 10)),
          confidence: 0.9, // AST-derived complexity is highly reliable
          title: `High complexity: ${s.name} (score: ${s.complexity})`,
          detail: `${s.name} has a cyclomatic complexity of ${s.complexity} across ${s.loc} lines. High branching logic is a prime source of regressions.`,
          file: s.file,
          line: s.line,
          symbol: s.id,
          blastRadius: s.fanIn,
          churn: repo.churnByFile?.[s.file] ?? 1,
          suggestedFix: `Extract nested conditionals/loops in ${s.name} into named helper functions. Early-return to flatten nesting.`,
          effort: "M",
        })
      );
    }

    return findings;
  },
};

// ---- Dead code ----
const deadcode: Specialist = {
  id: "deadcode",
  label: "Dead code",
  run({ repo, qe }) {
    return qe
      .deadCode()
      .slice(0, 25)
      .map((s) =>
        mk("deadcode", {
          severity: 2,
          confidence: s.exported ? 0.3 : 0.8, // local uncalled is very likely dead; exported might be an API
          title: `Unreferenced ${s.kind}: ${s.name}`,
          detail: `No resolved callers for ${s.name}. May be dead code, an entrypoint, or dynamically invoked \u2014 verify before removing.`,
          file: s.file,
          line: s.line,
          symbol: s.id,
          blastRadius: 1,
          churn: repo.churnByFile?.[s.file] ?? 1,
          suggestedFix: `Confirm ${s.name} is unused (grep for dynamic/string references), then remove it to cut maintenance surface.`,
          effort: "S",
        })
      );
  },
};

// ---- Dependency hygiene ----
const dependency: Specialist = {
  id: "dependency",
  label: "Dependency",
  run({ repo }) {
    return repo.issues
      .filter((i) => i.dimension === "dependency_hygiene")
      .slice(0, 25)
      .map((i) =>
        mk("dependency", {
          severity: i.severity,
          confidence: i.confidence ?? 0.8,
          title: i.title,
          detail: "Dependency hygiene issue affecting supply-chain reliability and reproducible builds.",
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          churn: i.churn,
          suggestedFix: fixForDep(i.title),
          effort: "S",
        })
      );
  },
};

function fixForDep(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("unpinned")) return "Pin the dependency to an exact/compatible version range for reproducible builds.";
  if (t.includes("lockfile")) return "Commit a lockfile (package-lock.json / pnpm-lock.yaml / yarn.lock) to freeze the dependency tree.";
  if (t.includes("pre-1.0")) return "Pre-1.0 deps may break on minor bumps; pin tightly and watch for breaking changes.";
  return "Review and stabilize this dependency.";
}

// ---- Architecture (circular deps) ----
const architecture: Specialist = {
  id: "architecture",
  label: "Architecture",
  run({ qe }) {
    return qe
      .cycles(15)
      .map((cycle) =>
        mk("architecture", {
          severity: 3,
          confidence: cycle.length === 2 ? 0.9 : 0.7, // tight cycles are certain bugs; long ones are structural
          title: `Circular dependency: ${cycle.slice(0, 3).join(" \u2192 ")}${cycle.length > 3 ? " \u2192 \u2026" : ""}`,
          detail: `A call cycle among ${cycle.length} symbols (${cycle.join(", ")}) complicates testing, initialization order, and reasoning.`,
          file: "",
          line: 1,
          symbol: null,
          blastRadius: cycle.length,
          churn: 1,
          suggestedFix: "Break the cycle by extracting a shared abstraction/interface or inverting one dependency direction.",
          effort: "M",
        })
      );
  },
};

// ---- Test integrity ----
const test: Specialist = {
  id: "test",
  label: "Test coverage",
  run({ repo, qe }) {
    const findings: Finding[] = [];
    
    // Pass 1: Keep the base repo-level issues (like "No test files detected")
    findings.push(...repo.issues
      .filter((i) => i.dimension === "test_integrity")
      .slice(0, 5)
      .map((i) =>
        mk("test", {
          severity: i.severity,
          confidence: i.confidence ?? 0.7,
          title: i.title,
          detail: "Insufficient tests reduce confidence to change code safely and let regressions ship.",
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          churn: i.churn,
          suggestedFix: "Add unit tests for the highest-fan-in untested functions first (max coverage-per-effort).",
          effort: "M",
        })
      ));

    // Pass 2: The actual intersection — hubs with zero test callers. The predicate and
    // its ordering live in `codeintel/query.ts` because the impact page reports the same
    // set; see `untestedHubs` for why it is shared rather than copied.
    for (const hub of untestedHubs(qe)) {
      findings.push(
        mk("test", {
          severity: Math.min(4, 2 + Math.floor(hub.fanIn / 5)), // scale severity with fan-in
          confidence: 0.85, // confident that we found no test callers in the graph
          title: `Untested core logic: ${hub.name}`,
          detail: `${hub.name} has ${hub.fanIn} production callers but zero callers from test files. A regression here has massive blast radius.`,
          file: hub.file,
          line: hub.line,
          symbol: hub.id,
          blastRadius: hub.fanIn,
          churn: repo.churnByFile?.[hub.file] ?? 1,
          suggestedFix: `Write a focused unit test for ${hub.name} covering its primary success and failure paths.`,
          effort: "M",
        })
      );
      if (findings.length >= 15) break;
    }
    
    return findings;
  },
};

export const SPECIALISTS: Specialist[] = [
  security,
  performance,
  refactor,
  deadcode,
  dependency,
  architecture,
  test,
];

export function resetSeq() {
  seq = 0;
}
