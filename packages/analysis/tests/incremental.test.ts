import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/index";
import type { IndexCacheStore, IndexResult } from "@codegraph/analysis-model";

/**
 * The only property that makes incremental indexing shippable: A RE-INDEX THAT REUSES WORK
 * MUST PRODUCE EXACTLY WHAT A COLD INDEX WOULD.
 *
 * Every test here is the same experiment — index, mutate, re-index with the cache, index the
 * same tree from scratch, compare — because a cache bug does not announce itself. It does not
 * throw and it does not slow anything down; it returns a graph that is subtly, permanently
 * wrong, and the product IS the graph. Speed assertions are deliberately absent: a fast wrong
 * answer is the failure being defended against, so timing belongs in a benchmark, not here.
 *
 * The load-bearing case is `moves a definition in an imported file`. Extraction resolves a
 * call through the type checker and records the target's LINE, so a file that did not change
 * one byte extracts differently when something it imports shifts. That is precisely why a
 * content hash alone is an unsound key, and why `planReuse` computes an import closure.
 */

const dirs: string[] = [];

/** In-memory `IndexCacheStore`. Structured-cloned so a test cannot accidentally share state
 * with the pipeline through an object reference the real (serialising) store would not. */
function memoryStore(): IndexCacheStore & { readonly writes: () => number; corrupt: () => void; drop: () => void } {
  let blob: string | null = null;
  let writes = 0;
  return {
    load: () => (blob === null ? null : JSON.parse(blob)),
    save: (payload) => {
      writes++;
      blob = JSON.stringify(payload);
    },
    writes: () => writes,
    corrupt: () => {
      blob = JSON.stringify({ version: "index-cache-v1", root: 42 });
    },
    drop: () => {
      blob = null;
    },
  };
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-incr-"));
  dirs.push(dir);
  write(dir, files);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

/**
 * Everything a caller can observe, minus the two fields that are ALLOWED to differ.
 *
 * `stageTimings` is wall clock and `incremental` is the reuse report itself — a run that
 * reused work is supposed to say so. Anything else differing is a defect.
 */
function comparable(r: IndexResult): string {
  const { stageTimings: _t, incremental: _i, ...rest } = r;
  return JSON.stringify(rest);
}

async function bothWays(dir: string, cache: IndexCacheStore): Promise<{ warm: IndexResult; cold: IndexResult }> {
  const warm = await indexRepo(dir, { cache });
  const cold = await indexRepo(dir);
  return { warm, cold };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { zod: "^3.0.0" } }),
  "package-lock.json": "{}",
  "src/target.ts": "export function target(n: number): number {\n  return n * 2;\n}\n",
  "src/caller.ts":
    'import { target } from "./target";\n\nexport function caller(n: number): number {\n  return target(n) + 1;\n}\n',
  "src/leaf.ts": "export const leaf = 1;\n",
  "src/lib.py": "def helper():\n    return 1\n",
};

describe("incremental re-index", () => {
  it("indexes fully the first time and leaves a cache behind", async () => {
    const cache = memoryStore();
    const r = await indexRepo(repo(BASE), { cache });
    expect(r.incremental).toMatchObject({ mode: "full", cacheWritten: true });
    expect(cache.writes()).toBe(1);
  });

  it("reuses everything when nothing changed, and agrees with a cold index", async () => {
    const dir = repo(BASE);
    const cache = memoryStore();
    await indexRepo(dir, { cache });

    const { warm, cold } = await bothWays(dir, cache);
    expect(warm.incremental?.mode).toBe("incremental");
    expect(warm.incremental?.filesChanged).toBe(0);
    expect(warm.incremental?.filesReused).toBeGreaterThan(0);
    expect(comparable(warm)).toBe(comparable(cold));
  });

  it("agrees with a cold index after an edit confined to one leaf file", async () => {
    const dir = repo(BASE);
    const cache = memoryStore();
    await indexRepo(dir, { cache });

    write(dir, { "src/leaf.ts": "export const leaf = 1;\nexport function grown(): number {\n  return leaf;\n}\n" });
    const { warm, cold } = await bothWays(dir, cache);
    expect(warm.incremental?.mode).toBe("incremental");
    expect(warm.incremental?.filesChanged).toBe(1);
    expect(comparable(warm)).toBe(comparable(cold));
  });

  it("moves a definition in an imported file and still agrees with a cold index", async () => {
    // THE case a content-keyed cache gets wrong. `caller.ts` is byte-identical, but the line
    // its call resolves to has moved, so its extraction is stale and must be redone.
    const dir = repo(BASE);
    const cache = memoryStore();
    const before = await indexRepo(dir, { cache });
    const edgeOf = (r: IndexResult) =>
      r.symbolGraph.edges.filter((e) => e.kind === "calls" && e.source.startsWith("src/caller.ts"));
    expect(edgeOf(before).length).toBeGreaterThan(0);

    write(dir, {
      "src/target.ts": "// pushed down\n// by two lines\nexport function target(n: number): number {\n  return n * 2;\n}\n",
    });
    const { warm, cold } = await bothWays(dir, cache);
    expect(warm.incremental?.mode).toBe("incremental");
    // The importer was invalidated even though its own bytes did not change.
    expect(warm.incremental?.filesChanged).toBe(1);
    expect(edgeOf(warm)).toEqual(edgeOf(cold));
    expect(comparable(warm)).toBe(comparable(cold));
  });

  it("invalidates transitively, through a re-export the importer never names", async () => {
    // Depth 1 is the case anyone would think to write. Depth 2 is the one that breaks a
    // closure implemented as "direct importers of changed files": `app.ts` imports `barrel.ts`
    // and calls a function that lives in `deep.ts`, so moving `deep.ts` changes what `app.ts`
    // resolves to without either of the two files between them changing a byte.
    const dir = repo({
      ...BASE,
      "src/deep.ts": "export function deep(): number {\n  return 3;\n}\n",
      "src/barrel.ts": 'export * from "./deep";\n',
      "src/app.ts": 'import { deep } from "./barrel";\n\nexport function app(): number {\n  return deep();\n}\n',
    });
    const cache = memoryStore();
    const before = await indexRepo(dir, { cache });
    const edgeOf = (r: IndexResult) =>
      r.symbolGraph.edges.filter((e) => e.kind === "calls" && e.source.startsWith("src/app.ts"));
    expect(edgeOf(before).length).toBeGreaterThan(0);

    write(dir, { "src/deep.ts": "// shifted\nexport function deep(): number {\n  return 3;\n}\n" });
    const { warm, cold } = await bothWays(dir, cache);
    expect(warm.incremental?.mode).toBe("incremental");
    expect(edgeOf(warm)).toEqual(edgeOf(cold));
    expect(comparable(warm)).toBe(comparable(cold));
  });

  it("agrees with a cold index when a new file is added and imported by an old one", async () => {
    const dir = repo(BASE);
    const cache = memoryStore();
    await indexRepo(dir, { cache });

    write(dir, {
      "src/added.ts": "export function added(): number {\n  return 7;\n}\n",
      "src/caller.ts":
        'import { target } from "./target";\nimport { added } from "./added";\n\nexport function caller(n: number): number {\n  return target(n) + added();\n}\n',
    });
    const { warm, cold } = await bothWays(dir, cache);
    expect(comparable(warm)).toBe(comparable(cold));
  });

  it("falls back to a full index when a file is deleted", async () => {
    // A deletion cannot be reasoned about from the CURRENT import graph — the edge that would
    // have told us who depended on the file is exactly what disappeared.
    const dir = repo(BASE);
    const cache = memoryStore();
    await indexRepo(dir, { cache });

    unlinkSync(path.join(dir, "src/leaf.ts"));
    const { warm, cold } = await bothWays(dir, cache);
    expect(warm.incremental?.mode).toBe("full");
    expect(warm.incremental?.reason).toMatch(/removed/);
    expect(comparable(warm)).toBe(comparable(cold));
  });

  it("falls back to a full index when a manifest or lockfile changes", async () => {
    // node_modules is never walked, so a dependency change is invisible to per-file hashes
    // while changing which @types the checker sees.
    const dir = repo(BASE);
    const cache = memoryStore();
    await indexRepo(dir, { cache });

    write(dir, { "package-lock.json": '{"lockfileVersion":3}' });
    const warm = await indexRepo(dir, { cache });
    expect(warm.incremental).toMatchObject({ mode: "full" });
    expect(warm.incremental?.reason).toMatch(/manifests or lockfiles/);
  });

  it("falls back to a full index when an ambient declaration changes", async () => {
    const dir = repo({ ...BASE, "src/globals.d.ts": "declare global {\n  const AMBIENT: number;\n}\nexport {};\n" });
    const cache = memoryStore();
    await indexRepo(dir, { cache });

    write(dir, { "src/globals.d.ts": "declare global {\n  const AMBIENT: string;\n}\nexport {};\n" });
    const warm = await indexRepo(dir, { cache });
    expect(warm.incremental).toMatchObject({ mode: "full" });
    expect(warm.incremental?.reason).toMatch(/ambient/);
  });

  it("treats a corrupt or foreign cache exactly like an absent one", async () => {
    const dir = repo(BASE);
    const cache = memoryStore();
    const clean = await indexRepo(dir);

    cache.corrupt();
    const fromCorrupt = await indexRepo(dir, { cache });
    expect(fromCorrupt.incremental?.mode).toBe("full");
    expect(comparable(fromCorrupt)).toBe(comparable(clean));

    cache.drop();
    const fromEmpty = await indexRepo(dir, { cache });
    expect(fromEmpty.incremental).toMatchObject({ mode: "full", reason: "no usable cache" });
    expect(comparable(fromEmpty)).toBe(comparable(clean));
  });

  it("survives a store that throws on both ends", async () => {
    // The fsx store promises never to throw; this asserts the pipeline does not DEPEND on
    // that promise. A cache is an optimisation, and an optimisation must not fail a run.
    const dir = repo(BASE);
    const hostile: IndexCacheStore = {
      load: () => {
        throw new Error("load exploded");
      },
      save: () => {
        throw new Error("save exploded");
      },
    };
    await expect(indexRepo(dir, { cache: hostile })).resolves.toBeDefined();
  });

  it("does not reuse a cache written for a different root", async () => {
    const cache = memoryStore();
    await indexRepo(repo(BASE), { cache });
    const other = await indexRepo(repo(BASE), { cache });
    expect(other.incremental).toMatchObject({ mode: "full" });
    expect(other.incremental?.reason).toMatch(/another root/);
  });
});
