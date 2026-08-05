import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { contentCache, type ExtractionRecord } from "@codegraph/core-graph";
import type { IndexCacheStore, ScannedFile } from "@codegraph/analysis-model";

/**
 * Incremental indexing: decide what a re-index is allowed to REUSE.
 *
 * The pipeline itself stays a full pass — it still walks the tree, still reads every file,
 * still recomputes the import graph, the score, and every derived view. That is deliberate:
 * those stages are map operations over data already in memory, they depend on the whole file
 * set (a new importer changes another file's blast radius), and making them incremental would
 * buy milliseconds while adding a second source of truth. Measured breakdown of a ~2.1s index
 * on this repository: the TypeScript program is 923ms of it, eslint 624ms, extraction 420ms,
 * spans 104ms. Everything else is noise.
 *
 * So the two things worth reusing are the two expensive per-file passes, and they have very
 * different soundness conditions:
 *
 *   · DETECTION is a pure function of the file's own bytes, so a content hash is a complete
 *     key. It goes through `contentCache` in `detect-engine`, needs nothing from this module,
 *     and is correct by construction.
 *
 *   · SYMBOL EXTRACTION is not. `resolvedTargetId` names a declaration in another file, found
 *     through the type checker, so a file can be byte-identical and still extract differently
 *     because something it imports moved. A content key here returns a stale edge, and a wrong
 *     edge in a graph product is worse than a missing one.
 *
 * This module computes the key extraction actually needs: content PLUS the transitive import
 * closure. A file is invalidated when it changed, or when anything it imports (transitively)
 * changed. Everything else may be reused, and the TypeScript program is then built over the
 * invalidated set alone — which is where the 923ms goes.
 *
 * WHERE THE ANALYSIS IS DELIBERATELY CONSERVATIVE. Every case below falls back to a full
 * rebuild rather than reasoning about it, because the cost of being wrong is a silently
 * incorrect graph and the cost of being conservative is one slow run:
 *
 *   · any file deleted (a rename is a delete plus an add) — the previous run's dependents of
 *     the deleted file cannot be recovered from the CURRENT import graph, which no longer has
 *     the edge;
 *   · any ambient declaration touched (`.d.ts`, `declare global/module/namespace`) — those
 *     reach files that import nothing;
 *   · any manifest, tsconfig or lockfile touched — resolution and `@types` change under us,
 *     and node_modules is not in the manifest;
 *   · the walk hit its file cap — the file set is then a function of directory-iteration
 *     order, not of the repository, so "unchanged" is not meaningful;
 *   · anything at all wrong with the cache: absent, unreadable, wrong schema, wrong engine
 *     version, wrong root.
 */

/**
 * Bump on ANY change that alters what extraction produces: the extractors, the symbol id
 * scheme, the compiler options used to build the program, or the shape of `ExtractionRecord`.
 *
 * A cache entry is keyed by this string. Forgetting to bump it does not fail loudly — it
 * serves records built by the previous version of the code, so a bug you just fixed keeps
 * being reported. That is why it is one constant in one file rather than a hash of something
 * clever: the discipline has to be visible.
 */
export const INDEX_CACHE_VERSION = "index-cache-v1";

/** Files whose content changes the meaning of every resolution in the repository. */
const GLOBAL_FILE_RE =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|jsconfig\.json)$/;

const AMBIENT_RE = /^\s*declare\s+(global|module|namespace)\b/m;

const TS_FAMILY_RE = /\.(ts|tsx|js|jsx|cjs|mjs)$/;

/** Probed in the same order as the symbol graph's own resolver, so the two agree. */
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

const toPosix = (rel: string): string => rel.split(path.sep).join("/");

/** What `indexRepo` needs back: what to re-extract, what to hand over as reusable. */
export interface ReusePlan {
  /** Repo-relative posix paths that must be re-extracted. */
  readonly invalidated: ReadonlySet<string>;
  /** Extraction records from the previous run, keyed by repo-relative posix path. */
  readonly reuse: ReadonlyMap<string, ExtractionRecord>;
  /** Files added or modified since the cached manifest. */
  readonly changed: number;
  /** True when nothing could be reused and the run is a plain full index. */
  readonly full: boolean;
  /** Human-readable justification, surfaced on `IndexResult.incremental.reason`. */
  readonly reason: string;
}

interface CachedFile {
  /** Content hash. Short key names because this payload is megabytes on a large repo. */
  h: string;
  /** Pass-1 extraction, absent for files no extractor handles. */
  x?: ExtractionRecord;
}

interface CachePayload {
  version: string;
  root: string;
  fingerprint: string;
  files: Record<string, CachedFile>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accept a payload only if every field this module will later dereference is present and of
 * the right kind.
 *
 * A cache is data written by an older version of this program, which makes it untrusted input
 * in the only sense that matters: it can be shaped wrong. Parsing it defensively here is what
 * lets the rest of the module use it without optional chaining on every access.
 */
function parsePayload(raw: unknown): CachePayload | null {
  if (!isRecord(raw)) return null;
  const { version, root, fingerprint, files } = raw;
  if (typeof version !== "string" || typeof root !== "string" || typeof fingerprint !== "string") return null;
  if (!isRecord(files)) return null;
  for (const entry of Object.values(files)) {
    if (!isRecord(entry) || typeof entry["h"] !== "string") return null;
    const x = entry["x"];
    if (x !== undefined && (!isRecord(x) || !Array.isArray(x["symbols"]) || !Array.isArray(x["references"]))) {
      return null;
    }
  }
  return { version, root, fingerprint, files: files as unknown as Record<string, CachedFile> };
}

/**
 * A digest of everything outside the scanned file set that changes how code resolves.
 *
 * `node_modules` is not walked (and must not be), so a dependency upgrade is invisible to the
 * per-file hashes while changing what `@types` the checker sees. Hashing the manifests and
 * lockfiles that govern it turns that invisible change into a full rebuild.
 */
export function globalFingerprint(files: readonly ScannedFile[]): string {
  const h = createHash("sha1");
  const relevant = files
    .filter((f) => GLOBAL_FILE_RE.test(toPosix(f.rel)))
    .map((f) => `${toPosix(f.rel)}:${f.hash}`)
    .sort();
  for (const line of relevant) h.update(line).update("\u0000");
  return h.digest("hex");
}

/**
 * Import specifiers this file pulls in, via TypeScript's own preprocessor.
 *
 * NOT the `imports` field on `ScannedFile`: that comes from a regex tuned for the display
 * graph and only keeps relative specifiers, and an under-approximation here is unsound in the
 * dangerous direction — a missed edge means a dependent is never invalidated. `preProcessFile`
 * is the scanner the compiler itself uses, so it sees `require`, dynamic `import()`,
 * `export … from`, and triple-slash references too.
 *
 * Memoised on content: a file that did not change cannot have changed its imports.
 */
function specifiersOf(text: string, ext: string): string[] {
  return contentCache.get(text, ext, "preprocess-v1", () => {
    const pre = ts.preProcessFile(text, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true);
    return [...pre.importedFiles.map((f) => f.fileName), ...pre.referencedFiles.map((f) => f.fileName)];
  });
}

/** Relative specifier → repo-relative posix path, mirroring the symbol graph's probing. */
function resolveSpecifier(fromRel: string, spec: string, known: ReadonlySet<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (known.has(joined)) return joined;
  for (const ext of RESOLVE_EXTS) if (known.has(joined + ext)) return joined + ext;
  for (const ext of RESOLVE_EXTS) {
    const idx = path.posix.join(joined, "index" + ext);
    if (known.has(idx)) return idx;
  }
  return null;
}

const fullPlan = (reason: string, changed: number): ReusePlan => ({
  invalidated: new Set<string>(),
  reuse: new Map<string, ExtractionRecord>(),
  changed,
  full: true,
  reason,
});

/**
 * Decide what this run may reuse.
 *
 * Returns a plan whose `full: true` form is always safe: `buildSymbolGraph` treats an empty
 * `reuse` map as "extract everything", so a plan that gives up is indistinguishable from
 * never having had a cache.
 */
export function planReuse(args: {
  root: string;
  files: readonly ScannedFile[];
  capHit: boolean;
  cache?: IndexCacheStore;
}): ReusePlan {
  const { root, files, capHit, cache } = args;
  if (!cache) return fullPlan("no cache configured", files.length);
  if (capHit) return fullPlan("file cap hit — the file set is not stable across runs", files.length);

  /**
   * The store's contract says neither method throws. This does not RELY on that: the store is
   * injected, so the contract is only as good as the caller, and a cache is an optimisation
   * that must never be able to fail a run.
   */
  let raw: unknown = null;
  try {
    raw = cache.load();
  } catch {
    return fullPlan("cache load failed", files.length);
  }
  const payload = parsePayload(raw);
  if (!payload) return fullPlan("no usable cache", files.length);
  if (payload.version !== INDEX_CACHE_VERSION) return fullPlan("engine version changed", files.length);
  if (payload.root !== root) return fullPlan("cache belongs to another root", files.length);

  const fingerprint = globalFingerprint(files);
  if (payload.fingerprint !== fingerprint) return fullPlan("manifests or lockfiles changed", files.length);

  const current = new Map<string, ScannedFile>();
  for (const f of files) current.set(toPosix(f.rel), f);

  for (const rel of Object.keys(payload.files)) {
    if (!current.has(rel)) return fullPlan(`file removed (${rel})`, current.size);
  }

  const changed = new Set<string>();
  for (const [rel, f] of current) {
    if (payload.files[rel]?.h !== f.hash) changed.add(rel);
  }

  for (const rel of changed) {
    const f = current.get(rel)!;
    if (rel.endsWith(".d.ts") || (f.text && AMBIENT_RE.test(f.text))) {
      return fullPlan(`ambient declarations changed (${rel})`, changed.size);
    }
  }

  const reuse = new Map<string, ExtractionRecord>();
  for (const [rel, entry] of Object.entries(payload.files)) {
    if (entry.x) reuse.set(rel, entry.x);
  }

  if (changed.size === 0) {
    return { invalidated: new Set<string>(), reuse, changed: 0, full: false, reason: `no file changed; reused ${reuse.size}` };
  }

  /**
   * Invalidate upwards through imports.
   *
   * The edge direction that matters is DEPENDENT → DEPENDENCY: if `a.ts` imports `b.ts` and
   * `b.ts` changed, `a.ts`'s resolutions may now point somewhere else, so `a.ts` is stale even
   * though its own bytes are identical. Built from the current file set rather than a cached
   * one, so a newly added file that an old file imports is picked up: the new file counts as
   * changed, and the closure carries that to its importers.
   */
  const known = new Set(current.keys());
  const dependents = new Map<string, string[]>();
  for (const [rel, f] of current) {
    if (!TS_FAMILY_RE.test(f.ext) || !f.text) continue;
    for (const spec of specifiersOf(f.text, f.ext)) {
      const target = resolveSpecifier(rel, spec, known);
      if (!target || target === rel) continue;
      const list = dependents.get(target);
      if (list) list.push(rel);
      else dependents.set(target, [rel]);
    }
  }

  const invalidated = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const dep of dependents.get(cur) ?? []) {
      if (invalidated.has(dep)) continue;
      invalidated.add(dep);
      queue.push(dep);
    }
  }

  const reusable = [...reuse.keys()].filter((rel) => !invalidated.has(rel)).length;
  return {
    invalidated,
    reuse,
    changed: changed.size,
    full: false,
    reason: `${changed.size} changed, ${invalidated.size} re-extracted, ${reusable} reused`,
  };
}

/**
 * Persist this run's manifest.
 *
 * Written as a COMPLETE snapshot of the current file set, never as a delta: a delta cannot
 * express a deletion, and a cache that silently keeps a deleted file's symbols is exactly the
 * failure the whole-manifest rewrite makes impossible.
 *
 * Returns whether a cache was actually left behind, which the run then reports — "incremental"
 * with `cacheWritten: false` means every subsequent run will be full, and that is worth being
 * able to see.
 */
export function saveManifest(args: {
  root: string;
  files: readonly ScannedFile[];
  extraction: ReadonlyMap<string, ExtractionRecord>;
  capHit: boolean;
  cache?: IndexCacheStore;
}): boolean {
  const { root, files, extraction, capHit, cache } = args;
  if (!cache || capHit) return false;
  const out: Record<string, CachedFile> = {};
  for (const f of files) {
    const rel = toPosix(f.rel);
    const x = extraction.get(rel);
    out[rel] = x ? { h: f.hash, x } : { h: f.hash };
  }
  const payload: CachePayload = {
    version: INDEX_CACHE_VERSION,
    root,
    fingerprint: globalFingerprint(files),
    files: out,
  };
  try {
    cache.save(payload);
  } catch {
    // Same reasoning as the guarded `load`: the next run simply indexes in full.
    return false;
  }
  return true;
}
