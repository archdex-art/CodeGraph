import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_CACHE_BYTES, createIndexCacheStore, dropIndexCacheStore } from "../src/index";

/**
 * The contract this file defends is narrow and absolute: NEITHER METHOD MAY THROW,
 * and `load` may never return something that was not written whole. Everything
 * below therefore goes through the real filesystem rather than a mock — the
 * failure modes at stake (a torn file that still parses, a rename that could not
 * complete, a directory the process cannot write) only exist at the syscall layer,
 * and a mocked `fs` would assert that our idea of `fs` is self-consistent instead.
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-idxcache-"));
  dirs.push(dir);
  return dir;
}

/**
 * Mirrors the naming rule deliberately, so the layout (`<sha1(key)>.json.gz`) is
 * pinned by a test rather than only by the implementation: the corruption cases
 * below have to be able to plant bytes at the exact path `load` will read.
 */
function slotPath(dir: string, key: string): string {
  return path.join(dir, `${createHash("sha1").update(key, "utf8").digest("hex")}.json.gz`);
}

function tmpLeftovers(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".tmp")) : [];
}

afterAll(() => {
  for (const dir of dirs) {
    // The unwritable-directory test strips write permission; restore it or the
    // cleanup itself fails and leaks a temp tree per run.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone or never chmod'd.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const KEY = "/Users/someone/src/CodeGraph";

// Not trivial on purpose: nested objects, arrays, an empty object, unicode, a
// negative float and a large integer. A round-trip that only proves `{a:1}`
// survives would pass with any serialiser, including a broken one.
const PAYLOAD = {
  version: 3,
  files: [
    { path: "src/a.ts", mtimeMs: 1754300000123, size: 4096, symbols: ["a", "b"] },
    { path: "src/ünïcode — 日本語.ts", mtimeMs: -1, size: 0, symbols: [] },
  ],
  edges: { "src/a.ts": ["src/b.ts", "src/c.ts"] },
  stats: { ratio: -0.5, total: 9007199254740991 },
  empty: {},
};

describe("round trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it("returns the payload it was given, structurally identical", () => {
    const store = createIndexCacheStore(dir, KEY);
    store.save(PAYLOAD);
    expect(store.load()).toEqual(PAYLOAD);
  });

  it("writes exactly one gzipped file, named for the hash of the key", () => {
    createIndexCacheStore(dir, KEY).save(PAYLOAD);
    expect(readdirSync(dir)).toEqual([path.basename(slotPath(dir, KEY))]);
    // Gzip magic. Proves the bytes on disk are compressed rather than the check
    // passing because both sides happen to agree on plain JSON.
    const bytes = readFileSync(slotPath(dir, KEY));
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it("leaves no .tmp file behind after a successful save", () => {
    createIndexCacheStore(dir, KEY).save(PAYLOAD);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("creates the cache directory on first save", () => {
    const nested = path.join(dir, "deep", "cache");
    createIndexCacheStore(nested, KEY).save(PAYLOAD);
    expect(createIndexCacheStore(nested, KEY).load()).toEqual(PAYLOAD);
  });

  it("overwrites a previous payload for the same key", () => {
    const store = createIndexCacheStore(dir, KEY);
    store.save(PAYLOAD);
    store.save({ version: 4 });
    expect(store.load()).toEqual({ version: 4 });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("keeps different keys in different slots", () => {
    createIndexCacheStore(dir, "/repo/one").save({ which: 1 });
    createIndexCacheStore(dir, "/repo/two").save({ which: 2 });
    expect(createIndexCacheStore(dir, "/repo/one").load()).toEqual({ which: 1 });
    expect(createIndexCacheStore(dir, "/repo/two").load()).toEqual({ which: 2 });
  });
});

describe("load degrades to null instead of throwing", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it("returns null for a key that was never written", () => {
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });

  it("returns null when the cache directory does not exist at all", () => {
    expect(createIndexCacheStore(path.join(dir, "never-created"), KEY).load()).toBeNull();
  });

  it("returns null for a truncated gzip stream", () => {
    // The power-loss shape: a file that starts out looking exactly right and stops.
    const whole = gzipSync(Buffer.from(JSON.stringify(PAYLOAD), "utf8"));
    writeFileSync(slotPath(dir, KEY), whole.subarray(0, Math.floor(whole.length / 2)));
    const store = createIndexCacheStore(dir, KEY);
    expect(() => store.load()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("returns null for a zero-length file", () => {
    writeFileSync(slotPath(dir, KEY), Buffer.alloc(0));
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });

  it("returns null for a file of pure garbage", () => {
    writeFileSync(slotPath(dir, KEY), Buffer.from("this is not gzip, it is a note", "utf8"));
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });

  it("returns null for valid gzip wrapping invalid JSON", () => {
    writeFileSync(slotPath(dir, KEY), gzipSync(Buffer.from('{"version":3,', "utf8")));
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });

  it.each([
    ["a JSON number", "123"],
    ["a JSON string", '"payload"'],
    ["JSON null", "null"],
    ["JSON true", "true"],
  ])("returns null for %s rather than handing back a non-object", (_label, json) => {
    // Callers index into the result. A primitive reaching them turns into a
    // property access on a non-object several stages downstream, where the cause
    // is no longer visible.
    writeFileSync(slotPath(dir, KEY), gzipSync(Buffer.from(json, "utf8")));
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });

  it("returns null when the slot is a directory", () => {
    // EISDIR on read. Not hypothetical: an interrupted mkdir race, or a user
    // poking at the cache dir, produces it.
    mkdirSync(slotPath(dir, KEY));
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });
});

describe("size cap", () => {
  it("is 64 MiB", () => {
    expect(MAX_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("declines to write an oversized payload and leaves the previous file intact", () => {
    const dir = freshDir();
    // A tiny cap stands in for the real one: reaching 64 MiB *gzipped* needs ~64 MiB
    // of incompressible data, which would make this test a memory event rather than
    // a test. The guard under test is the comparison, and it is the same comparison.
    createIndexCacheStore(dir, KEY).save({ generation: "first" });
    const before = readFileSync(slotPath(dir, KEY));

    createIndexCacheStore(dir, KEY, 32).save(PAYLOAD);

    expect(readFileSync(slotPath(dir, KEY))).toEqual(before);
    expect(createIndexCacheStore(dir, KEY).load()).toEqual({ generation: "first" });
    // The rejection must happen before anything is written, not after.
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("still writes a payload that lands exactly at the cap", () => {
    const dir = freshDir();
    const gzippedSize = gzipSync(Buffer.from(JSON.stringify(PAYLOAD), "utf8")).byteLength;
    createIndexCacheStore(dir, KEY, gzippedSize).save(PAYLOAD);
    expect(createIndexCacheStore(dir, KEY).load()).toEqual(PAYLOAD);
  });

  it("refuses to LOAD a slot already larger than the cap, without inflating it", () => {
    // The cap used to be enforced only on the write side, which guards nothing about a file
    // that is already on disk — written by an older build, a larger cap, or another process.
    // `loadFrom` then gunzipped it unconditionally into a Buffer, a JS string and a parsed
    // graph; at this module's own measured 6.6:1 ratio a slot at the 64 MiB cap is several
    // hundred MB of peak heap, i.e. an OOM on the 512 MB container. And because nothing
    // rewrites a slot whose load kills the process, it recurs on every run forever — a crash
    // loop, not an incident.
    const dir = freshDir();
    createIndexCacheStore(dir, KEY).save(PAYLOAD);
    const onDisk = readFileSync(slotPath(dir, KEY)).byteLength;

    // Returning null rather than PAYLOAD is itself the proof that nothing was inflated: the
    // payload can only be produced by gunzipping, so a build without the guard fails here with
    // the whole object. The bytes are untouched and valid — the same file loads fine below
    // once the cap allows it — so this is the cap rejecting it, not corruption.
    expect(createIndexCacheStore(dir, KEY, onDisk - 1).load()).toBeNull();
    expect(readFileSync(slotPath(dir, KEY)).byteLength).toBe(onDisk);
    expect(createIndexCacheStore(dir, KEY, onDisk).load()).toEqual(PAYLOAD);
  });
});

describe("save never throws", () => {
  it("returns normally when the cache directory cannot be created", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores mode bits
    const parent = freshDir();
    chmodSync(parent, 0o555);
    const store = createIndexCacheStore(path.join(parent, "cache"), KEY);
    expect(() => store.save(PAYLOAD)).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("returns normally when the cache directory exists but is not writable", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = freshDir();
    chmodSync(dir, 0o555);
    expect(() => createIndexCacheStore(dir, KEY).save(PAYLOAD)).not.toThrow();
    chmodSync(dir, 0o700);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("returns normally for a cyclic payload", () => {
    const dir = freshDir();
    const cyclic: Record<string, unknown> = { version: 3 };
    cyclic["self"] = cyclic;
    expect(() => createIndexCacheStore(dir, KEY).save(cyclic)).not.toThrow();
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("returns normally for a payload JSON cannot represent", () => {
    const dir = freshDir();
    const store = createIndexCacheStore(dir, KEY);
    expect(() => store.save(undefined)).not.toThrow();
    expect(() => store.save(() => 1)).not.toThrow();
    expect(store.load()).toBeNull();
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("returns normally when the slot is occupied by a non-empty directory", () => {
    // `rename(2)` onto a non-empty directory fails (ENOTEMPTY/EISDIR). The tmp file
    // must not survive that.
    const dir = freshDir();
    const slot = slotPath(dir, KEY);
    mkdirSync(slot);
    writeFileSync(path.join(slot, "squatter"), "x");
    expect(() => createIndexCacheStore(dir, KEY).save(PAYLOAD)).not.toThrow();
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});

describe("dropIndexCacheStore", () => {
  it("removes the slot, so the next load is a miss", () => {
    // Deleting a repo removed its workspace and its trash and left this file behind forever —
    // nothing else enumerates the cache directory, so index/delete cycles accumulated one
    // orphan per repo, each up to 64 MiB, on a 1 GB disk with no backup.
    const dir = freshDir();
    createIndexCacheStore(dir, KEY).save(PAYLOAD);
    expect(existsSync(slotPath(dir, KEY))).toBe(true);

    dropIndexCacheStore(dir, KEY);

    expect(existsSync(slotPath(dir, KEY))).toBe(false);
    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
  });

  it("is a silent no-op for a key that was never written", () => {
    // The common case for a repo deleted before it was ever indexed. A delete path that throws
    // here would abort a deletion that has already removed the data that mattered.
    const dir = freshDir();
    expect(() => dropIndexCacheStore(dir, KEY)).not.toThrow();
    expect(existsSync(slotPath(dir, KEY))).toBe(false);
  });

  it("does not throw when the cache directory does not exist at all", () => {
    expect(() => dropIndexCacheStore(path.join(freshDir(), "never-created"), KEY)).not.toThrow();
  });

  it("drops only the key it was given", () => {
    // Both stores share one derivation of `<dir>/<sha1(key)>.json.gz`. A drop that computed the
    // name even slightly differently would delete nothing — or, worse, something else.
    const dir = freshDir();
    const other = "/Users/someone/src/Other";
    createIndexCacheStore(dir, KEY).save(PAYLOAD);
    createIndexCacheStore(dir, other).save({ generation: "other" });

    dropIndexCacheStore(dir, KEY);

    expect(createIndexCacheStore(dir, KEY).load()).toBeNull();
    expect(createIndexCacheStore(dir, other).load()).toEqual({ generation: "other" });
  });
});
