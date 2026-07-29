/**
 * `@codegraph/core-domain` — the vocabulary the whole system shares (HLD §7).
 *
 * Pure types and pure functions. Zero runtime dependencies, zero I/O. Every
 * other package speaks this and may depend on it; it depends on nothing, which
 * is what keeps it free of cycles and makes it safe for the UI to import types
 * from.
 *
 * This file is the package's ONLY public surface (LLD §1.1) — the layering gate
 * fails a deep import.
 */

export type {
  Brand,
  FindingId,
  JobId,
  RepoId,
  RunId,
  SymbolId,
  ViewerId,
} from "./ids.js";
export { findingId, jobId, repoId, runId, symbolId, viewerId } from "./ids.js";

export type {
  AnalysisTier,
  ConfidenceBasis,
  DataflowStep,
  Dimension,
  Evidence,
  Finding,
  FindingStatus,
  Severity,
  SourceRange,
} from "./finding.js";
export { tierRank } from "./finding.js";

export type {
  AnalysisCoverage,
  AnalysisRun,
  DimensionScore,
  RunStatus,
  StageTiming,
} from "./run.js";

export type { FingerprintInput } from "./fingerprint.js";
export { fingerprint, normalizeSnippet } from "./fingerprint.js";
