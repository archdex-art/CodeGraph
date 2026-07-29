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
} from "./ids";
export { findingId, jobId, repoId, runId, symbolId, viewerId } from "./ids";

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
} from "./finding";
export { tierRank } from "./finding";

export type {
  AnalysisCoverage,
  AnalysisRun,
  DimensionScore,
  RunStatus,
  StageTiming,
} from "./run";

export type { FsEntry } from "./files";

export type { FingerprintInput } from "./fingerprint";
export { fingerprint, normalizeSnippet } from "./fingerprint";
