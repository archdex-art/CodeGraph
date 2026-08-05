import { createHash } from "node:crypto";

/**
 * Content-addressed memo for per-file work that is a pure function of the file's own text.
 *
 * **Where re-indexing actually happens.** Not users re-opening a repository - the product
 * itself indexes near-identical trees back to back. `agents/executor.ts` runs `indexRepo` twice
 * per remediation to measure the score delta before and after a fix, and
 * `gitops/historicalAnalysis.ts` indexes one snapshot per commit for the Timeline. The second
 * index of an almost-unchanged tree is the case worth making cheap.
 *
 * **What is cached, and why only this.** Profiled on this repository (303 TS files, ~2.1s):
 *
 * | phase | ms | pure in the file's text? |
 * |---|---|---|
 * | eslint security | 624 | yes |
 * | `ts.createProgram` | 567 | NO - whole program |
 * | symbol extraction | 420 | no - `resolvedTargetId` depends on other files |
 * | `getTypeChecker` | 199 | NO - whole program |
 * | `syntacticSpans` | 104 | yes |
 *
 * Only the two pure rows are memoised: 728ms of 2,100ms, about 35%. Extraction is deliberately
 * excluded even though it is the third-largest cost, because a reference's resolved target
 * points at a declaration in ANOTHER file - if that file moves, a content-keyed hit on this one
 * returns a stale edge. Caching it needs a dependency key, not a content key, and shipping the
 * unsound version would trade visible slowness for invisible wrong answers.
 *
 * **That dependency key now exists, and it is not here.** `@codegraph/analysis`'s
 * `incremental.ts` computes content PLUS the transitive import closure and hands the result to
 * `buildSymbolGraph` as an explicit reuse plan, which is also what lets the TypeScript program
 * be built over the invalidated files alone. It lives there rather than in this cache for the
 * reason this paragraph started with: the key is not a property of the file, so a per-file memo
 * is structurally the wrong place for it. This module keeps exactly the work whose key IS the
 * file - and `detect-engine`'s per-file findings joined it, on the same test.
 *
 * **`version` is not decoration.** Every entry is keyed by it, so changing a rule table or an
 * extractor and forgetting to bump it serves results from the old logic. It is threaded from
 * the caller rather than defaulted here, so the choice is visible at each call site.
 */
export interface ContentCacheStats {
  hits: number;
  misses: number;
  entries: number;
}

const MAX_ENTRIES = 4096;

/**
 * Bounded LRU. The Timeline indexes one snapshot per commit, so an unbounded map would grow
 * with history length and hold every version of every file for the life of the process.
 * Insertion order in a `Map` is the LRU order once hits re-insert.
 */
export class ContentCache {
  private readonly store = new Map<string, unknown>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number = MAX_ENTRIES) {}

  private static key(text: string, ext: string, version: string): string {
    return `${version}\u0000${ext}\u0000${createHash("sha1").update(text).digest("hex")}`;
  }

  /** Memoise `compute` on the exact bytes of `text`. */
  get<T>(text: string, ext: string, version: string, compute: () => T): T {
    const k = ContentCache.key(text, ext, version);
    if (this.store.has(k)) {
      const hit = this.store.get(k) as T;
      // Re-insert so the entry moves to the young end of the eviction order.
      this.store.delete(k);
      this.store.set(k, hit);
      this.hits++;
      return hit;
    }
    this.misses++;
    const value = compute();
    this.store.set(k, value);
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    return value;
  }

  stats(): ContentCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.store.size };
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * Process-wide instance.
 *
 * Shared deliberately: the two indexes of a remediation run, and every snapshot of a Timeline
 * walk, happen inside one process. A per-call cache would never see a second look at the same
 * bytes, which is the only case that pays.
 */
export const contentCache = new ContentCache();
