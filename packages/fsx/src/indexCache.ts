// Disk-backed store for the incremental index cache (HLD §8, "cache handle").
//
// The analysis pipeline is handed one of these as `PipelineContext.cache` and
// moves opaque JSON through it: `@codegraph/analysis` owns the payload schema and
// every invalidation rule, and is forbidden from depending on an I/O package
// (LLD §1.1). This file owns exactly the inverse — where the bytes live, and how
// they survive a crash — and knows nothing about what they mean.
//
// The interface is redeclared here rather than imported from
// `@codegraph/analysis-model`: fsx's ALLOWED list in .dependency-cruiser.cjs is
// {core-domain, config, observability}, and analysis-model sits ABOVE fsx. The two
// declarations are matched structurally at the injection site, which is where the
// mismatch would surface as a type error rather than at runtime.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { logger, serializeError } from "@codegraph/observability";

/**
 * Opaque persistence for the incremental index cache.
 *
 * NEITHER METHOD MAY THROW. A cache is an optimisation; an optimisation that can
 * fail a run is a liability. Every failure below degrades to "no cache" — which
 * costs a full re-index and nothing else — and is logged rather than raised.
 */
export interface IndexCacheStore {
  /** Previous payload, or null when absent/unreadable/corrupt. */
  load(): unknown | null;
  /** Best-effort persist. Silent no-op on failure. */
  save(payload: unknown): void;
}

/**
 * Largest gzipped cache file we will write: 64 MiB.
 *
 * The deployment target is a 512 MB container. An unbounded cache is a hazard on
 * both axes there — disk, and RSS, because `load` inflates the whole thing into a
 * Buffer and then into a JS string and then into a parsed object graph, so a file
 * this size is already several hundred MB of peak heap on the way back in. A
 * pathological repo (generated sources, vendored trees) is exactly the case that
 * would produce it, and exactly the case where a re-index is affordable. Above the
 * cap we decline to write, and decline to READ a file already at that size — see
 * `loadFrom`, where declining is what stops one oversized slot from being a crash
 * loop rather than a one-off.
 */
export const MAX_CACHE_BYTES = 64 * 1024 * 1024;

function loadFrom(file: string, maxBytes: number): unknown | null {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (error) {
    // The overwhelmingly common case is ENOENT on the first index of a repo, which
    // is not a fault and must not look like one in the logs. It gets a bare line:
    // a serialised Error with a full stack for an expected condition is the noise
    // that trains people to filter the channel that also carries EACCES — which is
    // genuinely worth seeing, and keeps its detail.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") logger.debug("index cache absent; indexing in full", { file });
    else logger.debug("index cache not read", { file, err: serializeError(error) });
    return null;
  }

  // THE CAP APPLIES ON THE WAY IN TOO. `saveTo` refuses to write above `maxBytes`, which
  // guards nothing about a file that is already there: a slot written by an older build, a
  // larger cap, or another process is read unconditionally, and the next three statements
  // inflate it into a Buffer, then a JS string, then a parsed object graph. At this file's
  // own measured 6.6:1 ratio a slot at the 64 MiB cap is several hundred MB of peak heap —
  // an unconditional OOM on the 512 MB container.
  //
  // Worse than a one-off crash: nothing rewrites a slot whose load kills the process, so the
  // run dies at the same byte on every retry, forever. Checking the on-disk length costs one
  // comparison and turns the crash loop back into what this module promises — a cache miss
  // and a full index. Left in place rather than unlinked: `save` will overwrite it with a
  // conforming file at the end of that full index, and a read path that deletes data is a
  // much larger claim than a read path that declines to read.
  if (raw.byteLength > maxBytes) {
    logger.warn("index cache exceeds size cap; ignoring and indexing in full", {
      file,
      bytes: raw.byteLength,
      maxBytes,
    });
    return null;
  }

  let text: string;
  try {
    text = gunzipSync(raw).toString("utf8");
  } catch (error) {
    // Reachable without any bug on our side: a machine that lost power between
    // `writeFileSync` and the filesystem flushing those blocks can leave a file of
    // the right length full of zeroes. Warn — a corrupt cache is silent extra work
    // on every subsequent run if it never gets rewritten.
    logger.warn("index cache is not valid gzip; ignoring", { file, err: serializeError(error) });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn("index cache is not valid JSON; ignoring", { file, err: serializeError(error) });
    return null;
  }

  // The producer validates the schema — it is the only side that can tell a stale
  // version from a current one. All we assert is the shape every caller indexes
  // into, so a payload of `null`/`4`/`"x"` cannot reach it as a property access on
  // a non-object. `typeof null === "object"` is why the null test is explicit.
  if (typeof parsed !== "object" || parsed === null) {
    logger.warn("index cache payload is not an object; ignoring", { file });
    return null;
  }
  return parsed;
}

function saveTo(dir: string, file: string, payload: unknown, maxBytes: number): void {
  // One try/catch around the entire body, deliberately. The contract is "never
  // throws", and the list of ways this can fail is open-ended: ENOSPC, EACCES,
  // EROFS, a full inode table, a cyclic object graph reaching JSON.stringify, an
  // OOM on a payload that outgrew memory between index and save. Enumerating them
  // individually would leave whichever one we did not think of able to fail a run.
  let tmp: string | null = null;
  try {
    const json = JSON.stringify(payload);
    // `undefined` for a payload of `undefined`, a function, or a symbol. There is
    // nothing to persist and `Buffer.from(undefined)` would throw a TypeError.
    if (json === undefined) {
      logger.warn("index cache payload is not serialisable; not written", { file });
      return;
    }

    // Default level (6), not 9. Measured on a synthetic 10.7 MB payload shaped like
    // a real one (60k file records, repeated keys, path-like strings): level 1 →
    // 2.42 MB in 12 ms, level 6 → 1.62 MB in 45 ms, level 9 → 1.60 MB in 102 ms.
    // Level 9 more than doubles the CPU for ~1% — never worth it here. Inflation is
    // ~10 ms at every level, so the read path does not care.
    const compressed = gzipSync(Buffer.from(json, "utf8"));
    if (compressed.byteLength > maxBytes) {
      logger.warn("index cache exceeds size cap; not written", {
        file,
        bytes: compressed.byteLength,
        maxBytes,
      });
      return;
    }

    mkdirSync(dir, { recursive: true });

    // Write-then-rename, because the worst possible outcome is a HALF-WRITTEN CACHE
    // THAT STILL PARSES: `load` would hand the pipeline a payload describing files
    // it never got to record, and the resulting index would be wrong in a way no
    // validation upstream can detect. `rename(2)` is atomic within a filesystem, so
    // a reader sees either the whole old file or the whole new one. The tmp name
    // therefore has to live in the SAME directory — a cross-device rename fails with
    // EXDEV — and carries pid + randomness so two concurrent indexes of the same
    // repo (two workers, or a retry racing its predecessor) cannot collide on it.
    tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, compressed);
    renameSync(tmp, file);
    tmp = null;

    // No fsync: durability across power loss is not worth an fsync per index for a
    // file we are happy to lose. The failure mode that leaves behind is a torn or
    // zero-filled file, which `load` rejects at the gzip step and treats as a miss.
  } catch (error) {
    logger.warn("index cache save failed; continuing without it", {
      file,
      err: serializeError(error),
    });
  } finally {
    // `tmp` is non-null only if we created it and the rename did not complete.
    // Leaving it behind would accumulate one orphan per failed save in a directory
    // nothing else ever prunes.
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing further to do, and this is already the error path.
      }
    }
  }
}

/**
 * Where one repo's slot lives: `<dir>/<sha1(key)>.json.gz`.
 *
 * `key` is the absolute repo root, which cannot be a filename directly — it contains
 * separators, may exceed NAME_MAX, and on a case-insensitive filesystem two distinct roots
 * can collide. sha1 is a name here, not a security boundary; nothing trusts the digest to be
 * unforgeable, so its collision weakness is irrelevant and its speed is not.
 *
 * Derived in ONE place because two callers now depend on it: a `drop` that computed the
 * filename slightly differently from `create` would silently delete nothing and leave the
 * leak it exists to fix.
 */
function slotPath(dir: string, key: string): string {
  return path.join(dir, `${createHash("sha1").update(key, "utf8").digest("hex")}.json.gz`);
}

/**
 * Open the cache slot for one repo.
 *
 * `dir` is the cache directory (created recursively on first save, not before —
 * a repo that is only ever read should not leave a directory behind), and `key`
 * is the absolute repo root.
 *
 * Cheap and stateless: the returned object closes over two strings and holds no
 * handle, so it is safe to create per run and impossible to share state through.
 *
 * `maxBytes` exists so the size cap can be exercised by a test without allocating
 * 64 MiB of incompressible data; production callers pass two arguments. It bounds both
 * directions — what `save` will write, and what `load` will inflate.
 */
export function createIndexCacheStore(
  dir: string,
  key: string,
  maxBytes: number = MAX_CACHE_BYTES,
): IndexCacheStore {
  const file = slotPath(dir, key);
  return {
    load: () => loadFrom(file, maxBytes),
    save: (payload) => saveTo(dir, file, payload, maxBytes),
  };
}

/**
 * Delete one repo's cache slot. Best effort; never throws.
 *
 * Deleting a repo removes its workspace and its trash, and used to leave this file behind
 * forever — nothing else enumerates the cache directory, so an index/delete cycle accumulated
 * one orphan per repo on a 1 GB disk with no backup, each up to the 64 MiB cap. The slot is
 * keyed on the absolute repo root, so a re-add at the same path would even resurrect a stale
 * cache for a repo that no longer exists.
 *
 * Silent on ENOENT: "there is no slot" is the desired end state, not a fault, and it is the
 * common case for a repo deleted before it was ever indexed. Everything else is logged and
 * swallowed — the caller is mid-delete, and a cache file it could not remove must not fail a
 * deletion that already removed the data that mattered.
 */
export function dropIndexCacheStore(dir: string, key: string): void {
  const file = slotPath(dir, key);
  try {
    unlinkSync(file);
    logger.debug("index cache slot dropped", { file });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") logger.debug("index cache slot already absent", { file });
    else logger.debug("index cache slot not dropped", { file, err: serializeError(error) });
  }
}
