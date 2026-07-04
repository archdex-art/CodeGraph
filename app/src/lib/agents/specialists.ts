import type { RepoDetail } from "../types";
import { QueryEngine } from "../codeintel/query";
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
  run({ repo }) {
    return repo.issues
      .filter((i) => i.dimension === "security")
      .slice(0, 40)
      .map((i) =>
        mk("security", {
          severity: i.severity,
          confidence: i.severity >= 4 ? 0.9 : 0.65,
          title: i.title,
          detail: `Security-sensitive pattern on a path with blast radius ${i.blastRadius}. Exploitable code reachable from ${i.blastRadius} caller(s) warrants review.`,
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          suggestedFix: fixForSecurity(i.title),
          effort: i.severity >= 4 ? "M" : "S",
        })
      );
  },
};

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
          confidence: 0.55,
          title: `Hot path: ${s.name} (${s.fanIn} callers)`,
          detail: `${s.name} is called from ${s.fanIn} sites. Optimizations here (caching, reduced allocation, memoization) have amplified impact.`,
          file: s.file,
          line: s.line,
          symbol: s.id,
          blastRadius: s.fanIn,
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
  run({ repo }) {
    return repo.issues
      .filter((i) => i.dimension === "maintainability" && /large file/i.test(i.title))
      .slice(0, 20)
      .map((i) =>
        mk("refactor", {
          severity: i.severity,
          confidence: 0.7,
          title: i.title,
          detail: `Large modules are hard to test and reason about, and raise merge-conflict risk. Blast radius ${i.blastRadius}.`,
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          suggestedFix: "Split this file along cohesive responsibilities into smaller modules; extract pure helpers.",
          effort: "L",
        })
      );
  },
};

// ---- Dead code ----
const deadcode: Specialist = {
  id: "deadcode",
  label: "Dead code",
  run({ qe }) {
    return qe
      .deadCode()
      .slice(0, 25)
      .map((s) =>
        mk("deadcode", {
          severity: 2,
          confidence: 0.5, // name-based resolution; could be entrypoint/dynamic
          title: `Unreferenced ${s.kind}: ${s.name}`,
          detail: `No resolved callers for ${s.name}. May be dead code, an entrypoint, or dynamically invoked \u2014 verify before removing.`,
          file: s.file,
          line: s.line,
          symbol: s.id,
          blastRadius: 1,
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
          confidence: 0.8,
          title: i.title,
          detail: "Dependency hygiene issue affecting supply-chain reliability and reproducible builds.",
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
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
          confidence: 0.75,
          title: `Circular dependency: ${cycle.slice(0, 3).join(" \u2192 ")}${cycle.length > 3 ? " \u2192 \u2026" : ""}`,
          detail: `A call cycle among ${cycle.length} symbols (${cycle.join(", ")}) complicates testing, initialization order, and reasoning.`,
          file: "",
          line: 1,
          symbol: null,
          blastRadius: cycle.length,
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
  run({ repo }) {
    return repo.issues
      .filter((i) => i.dimension === "test_integrity")
      .slice(0, 15)
      .map((i) =>
        mk("test", {
          severity: i.severity,
          confidence: 0.7,
          title: i.title,
          detail: "Insufficient tests reduce confidence to change code safely and let regressions ship.",
          file: i.file,
          line: i.line,
          symbol: null,
          blastRadius: i.blastRadius,
          suggestedFix: "Add unit tests for the highest-fan-in untested functions first (max coverage-per-effort).",
          effort: "M",
        })
      );
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
