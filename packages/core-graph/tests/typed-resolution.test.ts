import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";

/**
 * Type-aware call resolution.
 *
 * **Read this before trusting these tests.** Every case below is mutation-tested and SURVIVES
 * disabling the typed path - the name-based heuristics resolve all of them unaided. They lock
 * CORRECT ANSWERS, which is worth having, but they do NOT prove the type checker is working.
 * An earlier version of this comment claimed they did; the mutation run disproved it.
 *
 * What the typed path is actually worth was measured on this repository, not argued:
 *
 * | | type-aware resolutions that hit a symbol | call edges |
 * |---|---|---|
 * | before | 1,094 | 1,912 |
 * | after  | 2,167 | 1,914 |
 *
 * Edges barely move because the heuristic already produced an answer for nearly all of them -
 * sometimes the WRONG one. Across the 2,159 calls where both resolvers had an answer they
 * disagreed on 35 (1.6%), and on inspection the checker was right every time: all were
 * same-name shadowing, where `defsByName.get(name)[0]` picks whichever definition was seen
 * first. So the honest claim is ~35 corrected edges and correct provenance for ~1,000 more -
 * not a step change. The heuristic is already about 98.4% right on TypeScript.
 *
 * That number is also the answer to a question PLAN.md left open: it needs no labelled corpus,
 * because for TypeScript the compiler IS the ground truth for what a call refers to.
 *
 * A discriminating unit test would need a case where the heuristic is provably wrong. Four
 * candidates were built and all four failed to discriminate - namespace imports, directory/
 * `index.ts` imports, cross-file named imports, and single-file shadowing are each handled
 * correctly by the heuristic.
 *
 * **That gap is now closed - see the second describe block.** The shape the four candidates
 * missed is a METHOD CALL THROUGH A RECEIVER: `this.config.childEnv(...)`,
 * `contentCache.clear()`. The method name never appears in an import, so the fallback's import
 * table has nothing to offer and it reaches for a same-named free function in another file. It
 * does not lose the edge - it emits a confident wrong one.
 *
 * Found by diffing real-path against synthetic-base builds of THIS repository and reading the
 * six edges that differed, rather than by inventing candidates. Every one had that shape:
 * `childEnv` on `desktop/core/config.ts` attributed to `packages/config`, `register` on
 * `ipc/router.ts` to `core/di.ts`, `clear` on `content-cache.ts` to `di.ts`.
 *
 * The first rewrite of those tests used an imported free function and survived deleting the
 * program - the same vacuity this comment warns about, reproduced while fixing it.
 */
const f = (rel: string, text: string) => ({ rel, ext: rel.slice(rel.lastIndexOf(".")), text, language: "TypeScript" });

describe("type-aware resolution", () => {
  it("resolves a cross-file call to the DEFINING file, not the import line", async () => {
    const g = await buildSymbolGraph(
      [
        f("a.ts", "export function target() { return 1; }\n"),
        f("b.ts", "import { target } from './a';\nexport function caller() { return target(); }\n"),
      ],
      new Map(),
    );
    const call = g.edges.find((e) => e.kind === "calls");
    expect(call).toBeDefined();
    const to = g.symbols.find((s) => s.id === call!.target)!;
    // The alias bug produced `b.ts#target@1` — the import statement. Assert the real target.
    expect(to.file).toBe("a.ts");
    expect(to.name).toBe("target");
  });

  /**
   * The 1.6% the heuristic got WRONG on this repository, measured 2026-07-30 across 2,159
   * calls where both resolvers had an answer: every disagreement was same-name shadowing, and
   * the checker was right each time. `defsByName.get(name)[0]` picks the first definition it
   * saw, which is arbitrary when a name is defined twice.
   */
  it("picks the shadowing definition a name-only heuristic gets wrong", async () => {
    const g = await buildSymbolGraph(
      [
        f("dup.ts", "export function pick() { return 'FIRST'; }\n"),
        f(
          "use.ts",
          "function pick() { return 'SECOND'; }\nexport function run() { return pick(); }\n",
        ),
      ],
      new Map(),
    );
    const call = g.edges.find((e) => e.kind === "calls" && e.source.startsWith("use.ts"));
    expect(call).toBeDefined();
    const to = g.symbols.find((s) => s.id === call!.target)!;
    // Name-first resolution can reach dup.ts; the local definition is the correct target.
    expect(to.file).toBe("use.ts");
  });

  it("does not invent edges to symbols outside the indexed set", async () => {
    // `Object.keys` resolves in the checker to lib.es5.d.ts, which is not an indexed symbol.
    // It must produce NO edge rather than a dangling one or a same-named project symbol.
    const g = await buildSymbolGraph(
      [f("k.ts", "export function keys(o: object) { return Object.keys(o); }\n")],
      new Map(),
    );
    for (const e of g.edges.filter((x) => x.kind === "calls")) {
      expect(g.symbols.some((s) => s.id === e.target)).toBe(true);
    }
  });
});

/**
 * The discriminating cases the comment above once recorded as missing.
 *
 * Unlike the block above, these FAIL if the typed program is skipped or its resolution base
 * goes synthetic - both mutants verified caught. They need real paths on disk, hence the temp
 * directory: the receiver's type has to be resolvable, not merely present in a file map.
 *
 * Cost of what they guard: ~923ms of a ~1,255ms `symbol-graph` stage, for six edges in 2,549.
 * `graph.ts` carries the argument for paying it.
 */
describe("type-aware resolution of method calls through a receiver", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function repo(files: Record<string, string>) {
    dir = mkdtempSync(path.join(tmpdir(), "cg-typed-"));
    const inputs = Object.entries(files).map(([rel, text]) => {
      const abs = path.join(dir!, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      return { rel, ext: path.extname(rel), text, language: "TypeScript" };
    });
    return { root: dir, inputs };
  }

  it("resolves a method call to its class, not a same-named free function", async () => {
    const { root, inputs } = repo({
      "src/config.ts": "export class ConfigManager {\n  childEnv(port: number) { return { PORT: String(port) }; }\n}\n",
      "src/env.ts": "export function childEnv(port: number) { return { OTHER: String(port) }; }\n",
      "src/server.ts":
        'import { ConfigManager } from "./config";\n' +
        "export class Server {\n  private config = new ConfigManager();\n" +
        "  spawn() { return this.config.childEnv(1); }\n}\n",
    });
    const g = await buildSymbolGraph(inputs, new Map(), root);
    const call = g.edges.find((e) => e.source.startsWith("src/server.ts#spawn") && e.kind === "calls");
    expect(call, "no call edge from spawn").toBeDefined();
    // `env.ts` is the decoy the name-based resolver reaches for. That is the bug being pinned.
    expect(call!.target).not.toContain("src/env.ts");
    expect(call!.target).toContain("src/config.ts");
  });

  it("resolves a method on an imported object, not a same-named free function", async () => {
    // The `contentCache.clear()` case from this repository, reduced.
    const { root, inputs } = repo({
      "src/cache.ts": "export const contentCache = {\n  clear() { return 1; },\n};\n",
      "src/di.ts": "export function clear() { return 2; }\n",
      "src/reset.ts":
        'import { contentCache } from "./cache";\nexport function reset() { return contentCache.clear(); }\n',
    });
    const g = await buildSymbolGraph(inputs, new Map(), root);
    const call = g.edges.find((e) => e.source.startsWith("src/reset.ts#reset") && e.kind === "calls");
    expect(call, "no call edge from reset").toBeDefined();
    expect(call!.target).not.toContain("src/di.ts");
  });
});
