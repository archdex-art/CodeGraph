/**
 * Branded identifiers (LLD §2).
 *
 * These are compile-time-only wrappers: `RepoId` is a `string` at runtime with
 * zero cost. The point is that a function taking `(repoId: RepoId, runId: RunId)`
 * cannot be called with the arguments swapped, which is a mistake plain `string`
 * parameters make easy and silent — and one that reads across tenants when the
 * id in question is a viewer.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RepoId = Brand<string, "RepoId">;
export type RunId = Brand<string, "RunId">;
export type JobId = Brand<string, "JobId">;
export type SymbolId = Brand<string, "SymbolId">;
export type FindingId = Brand<string, "FindingId">;

/**
 * The identity of whoever is asking. Every persistence read takes one
 * (LLD §8) — tenant isolation is a type-level obligation rather than a check
 * each route has to remember.
 *
 * `null` is the anonymous/public bucket and is a deliberate, explicit value, not
 * an absent argument: `byId(id)` must not compile, while `byId(id, null)` reads
 * as "the public bucket" at the call site.
 */
export type ViewerId = Brand<number, "ViewerId"> | null;

// Constructors. Narrow, boring, and the only sanctioned way in — a cast at a
// call site is reviewable precisely because these exist.
export const repoId = (raw: string): RepoId => raw as RepoId;
export const runId = (raw: string): RunId => raw as RunId;
export const jobId = (raw: string): JobId => raw as JobId;
export const symbolId = (raw: string): SymbolId => raw as SymbolId;
export const findingId = (raw: string): FindingId => raw as FindingId;
export const viewerId = (raw: number | null | undefined): ViewerId =>
  raw === null || raw === undefined ? null : (raw as ViewerId);
