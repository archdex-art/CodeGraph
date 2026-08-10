import { buildSymbolGraph, QueryEngine } from "@codegraph/core-graph";
import { describe, expect, it } from "vitest";
import { findUnusedDependencies, replacementImpact } from "../src/depintel";

/**
 * Dependency intelligence.
 *
 * Every case below is a real false-positive class for "unused dependency" tooling, and each is
 * asserted on the CAVEAT and the CONFIDENCE, not merely on absence from a list. A detector
 * that excludes the right package for the wrong reason — or reports it with no warning
 * attached — is the failure mode that gets a working dependency deleted.
 */

type Declared = { name: string; manifest: string; scope: string };

function run(input: {
  declared: readonly Declared[];
  imported?: readonly string[];
  scripts?: Record<string, string>;
  configFiles?: readonly string[];
}) {
  return findUnusedDependencies({
    declared: input.declared,
    importedPackages: new Set(input.imported ?? []),
    manifestScripts: new Map(Object.entries(input.scripts ?? {})),
    configFiles: input.configFiles ?? [],
  });
}

const dep = (name: string, scope = "dependencies"): Declared => ({
  name,
  manifest: "package.json",
  scope,
});

describe("findUnusedDependencies — the confident case", () => {
  it("reports a plainly unreferenced runtime dependency with high confidence and no caveat", () => {
    const out = run({ declared: [dep("left-pad")], imported: ["react"] });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("left-pad");
    expect(out[0]!.scope).toBe("dependencies");
    expect(out[0]!.declaredIn).toBe("package.json");
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(out[0]!.caveat).toBeNull();
  });

  it("never reaches certainty — dynamic require() is invisible here", () => {
    const out = run({ declared: [dep("left-pad")] });
    expect(out[0]!.confidence).toBeLessThan(1);
  });

  it("does not report a dependency that is imported by its exact name", () => {
    expect(run({ declared: [dep("react")], imported: ["react"] })).toEqual([]);
  });

  it("skips a scope it cannot reason about rather than guessing", () => {
    expect(run({ declared: [dep("left-pad", "bundleDependencies")] })).toEqual([]);
  });
});

describe("findUnusedDependencies — false-positive classes", () => {
  it("downgrades @types/* to low confidence with a caveat naming the compiler", () => {
    const out = run({ declared: [dep("@types/left-pad", "devDependencies")] });
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeLessThan(0.3);
    expect(out[0]!.caveat).toMatch(/@types/);
    expect(out[0]!.caveat).toMatch(/TypeScript compiler/);
  });

  it("does not report @types/x at all when the runtime package it types is imported", () => {
    expect(
      run({
        declared: [dep("@types/lodash", "devDependencies")],
        imported: ["lodash"],
      }),
    ).toEqual([]);
  });

  it("resolves the DefinitelyTyped __ mangling for scoped packages", () => {
    expect(
      run({
        declared: [dep("@types/babel__core", "devDependencies")],
        imported: ["@babel/core"],
      }),
    ).toEqual([]);
  });

  it("does not report a dependency used only from a scripts command", () => {
    expect(
      run({
        declared: [dep("vitest", "devDependencies")],
        scripts: { test: "vitest run --coverage" },
      }),
    ).toEqual([]);
  });

  it("matches script tokens whole — `ts` is not used by a script running `tsc`", () => {
    const out = run({ declared: [dep("ts", "devDependencies")], scripts: { build: "tsc -p ." } });
    expect(out.map((u) => u.name)).toEqual(["ts"]);
  });

  it("counts a script invoking a subpath binary as a reference to the package", () => {
    expect(
      run({
        declared: [dep("@codegraph/cli", "devDependencies")],
        scripts: { start: "node @codegraph/cli/bin/run.js" },
      }),
    ).toEqual([]);
  });

  it("does not report an eslint plugin when an eslint config file is present", () => {
    expect(
      run({
        declared: [dep("eslint-plugin-security", "devDependencies")],
        configFiles: ["eslint.config.js"],
      }),
    ).toEqual([]);
  });

  it("still reports an eslint plugin with NO eslint config, but with the plugin caveat", () => {
    const out = run({
      declared: [dep("eslint-plugin-security", "devDependencies")],
      configFiles: ["tsconfig.json"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.caveat).toMatch(/plugin\/preset/);
    expect(out[0]!.confidence).toBeLessThan(0.4);
  });

  it("excludes plugins of the other ecosystems on their own config files", () => {
    expect(
      run({
        declared: [
          dep("postcss-nested", "devDependencies"),
          dep("prettier-plugin-tailwindcss", "devDependencies"),
          dep("babel-plugin-macros", "devDependencies"),
        ],
        configFiles: ["postcss.config.js", ".prettierrc", "babel.config.json"],
      }),
    ).toEqual([]);
  });

  it("does not report a peerDependency — the consumer imports it, not us", () => {
    expect(run({ declared: [dep("react", "peerDependencies")] })).toEqual([]);
  });

  it("does not report a dependency imported only as `pkg/sub` — the subpath bug", () => {
    expect(run({ declared: [dep("lodash")], imported: ["lodash/get"] })).toEqual([]);
  });

  it("does not report a scoped dependency imported only via a subpath", () => {
    expect(
      run({ declared: [dep("@scope/pkg")], imported: ["@scope/pkg/client"] }),
    ).toEqual([]);
  });

  it("does not confuse `lodash-es` with a `lodash` subpath import", () => {
    const out = run({ declared: [dep("lodash-es")], imported: ["lodash/get"] });
    expect(out.map((u) => u.name)).toEqual(["lodash-es"]);
  });

  it("treats node: builtins as evidence for @types/node", () => {
    expect(
      run({ declared: [dep("@types/node", "devDependencies")], imported: ["node:fs"] }),
    ).toEqual([]);
  });

  it("ignores relative specifiers when building the imported set", () => {
    const out = run({ declared: [dep("left-pad")], imported: ["./left-pad", "../left-pad"] });
    expect(out.map((u) => u.name)).toEqual(["left-pad"]);
  });

  it("scores a devDependency below an identical runtime dependency", () => {
    const runtime = run({ declared: [dep("left-pad")] })[0]!;
    const development = run({ declared: [dep("left-pad", "devDependencies")] })[0]!;
    expect(development.confidence).toBeLessThan(runtime.confidence);
    expect(development.caveat).toMatch(/devDependency/);
  });

  it("scores an optionalDependency lower still, and says why", () => {
    const optional = run({ declared: [dep("fsevents", "optionalDependencies")] })[0]!;
    expect(optional.confidence).toBeLessThan(0.55);
    expect(optional.caveat).toMatch(/optionalDependency/);
  });

  it("stacks the caveats when several classes apply at once", () => {
    const out = run({ declared: [dep("@types/left-pad", "devDependencies")] })[0]!;
    expect(out.caveat).toMatch(/@types/);
    expect(out.caveat).toMatch(/devDependency/);
  });

  it("returns candidates in a deterministic order regardless of input order", () => {
    const names = ["zulu", "alpha", "mike"].map((n) => dep(n));
    const forward = run({ declared: names }).map((u) => u.name);
    const backward = run({ declared: [...names].reverse() }).map((u) => u.name);
    expect(forward).toEqual(["alpha", "mike", "zulu"]);
    expect(backward).toEqual(forward);
  });
});

/** `buildSymbolGraph` takes scanned-file shape; `replacementImpact` takes text only. */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

describe("replacementImpact", () => {
  const lib = f(
    "lib.ts",
    'import chalk from "chalk";\nexport function paint(s: string) { return chalk.red(s); }\n',
  );
  const mid = f(
    "mid.ts",
    'import { paint } from "./lib";\nexport function render(s: string) { return paint(s); }\n',
  );
  const top = f(
    "top.ts",
    'import { render } from "./mid";\nexport function page() { return render("hi"); }\n',
  );

  it("reports the import site, the direct symbols, and a transitive caller that never imports the package", async () => {
    const files = [lib, mid, top];
    const graph = await buildSymbolGraph(files, new Map());
    const qe = new QueryEngine(graph);
    const impact = replacementImpact("chalk", files, graph, qe);

    expect(impact.package).toBe("chalk");
    expect(impact.importSites).toEqual([{ file: "lib.ts", line: 1, symbolId: null }]);

    const paint = graph.symbols.find((s) => s.name === "paint")!;
    const render = graph.symbols.find((s) => s.name === "render")!;
    const page = graph.symbols.find((s) => s.name === "page")!;

    expect(impact.directSymbols).toContain(paint.id);
    // `render` is in mid.ts, which has no `chalk` import anywhere in it — it only breaks
    // because it calls through `paint`. That indirection is the whole point of the query.
    expect(mid.text).not.toContain("chalk");
    expect(impact.blastRadius).toContain(render.id);
    expect(impact.blastRadius).toContain(page.id);
    // A direct symbol is never double-counted as its own blast radius.
    expect(impact.blastRadius).not.toContain(paint.id);
    expect(impact.truncated).toBe(false);
  });

  it("finds the package when it is imported only via a subpath", async () => {
    const files = [f("a.ts", 'import get from "lodash/get";\nexport const x = get;\n')];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("lodash", files, graph, new QueryEngine(graph));
    expect(impact.importSites.map((s) => s.line)).toEqual([1]);
  });

  it("finds require() and dynamic import() sites, not just static imports", async () => {
    const files = [
      f("r.ts", 'const chalk = require("chalk");\n'),
      f("d.ts", 'export async function load() { return import("chalk"); }\n'),
    ];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("chalk", files, graph, new QueryEngine(graph));
    expect(impact.importSites.map((s) => `${s.file}:${s.line}`)).toEqual(["d.ts:1", "r.ts:1"]);
  });

  it("attributes an import inside a function body to that function", async () => {
    const files = [
      f("d.ts", 'export async function load() {\n  return import("chalk");\n}\n'),
    ];
    const graph = await buildSymbolGraph(files, new Map());
    const qe = new QueryEngine(graph);
    const impact = replacementImpact("chalk", files, graph, qe);
    const load = graph.symbols.find((s) => s.name === "load")!;
    expect(impact.importSites).toEqual([{ file: "d.ts", line: 2, symbolId: load.id }]);
  });

  it("does not match a different package that shares a prefix", async () => {
    const files = [f("a.ts", 'import x from "chalk-template";\nexport const y = x;\n')];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("chalk", files, graph, new QueryEngine(graph));
    expect(impact.importSites).toEqual([]);
    expect(impact.directSymbols).toEqual([]);
    expect(impact.blastRadius).toEqual([]);
  });

  it("reports nothing, untruncated, for a package no file imports", async () => {
    const files = [f("a.ts", "export function solo() { return 1; }\n")];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("chalk", files, graph, new QueryEngine(graph));
    expect(impact).toEqual({
      package: "chalk",
      importSites: [],
      directSymbols: [],
      blastRadius: [],
      truncated: false,
    });
  });

  it("inherits truncation from a truncated symbol graph rather than claiming completeness", async () => {
    const files = [f("a.ts", 'import chalk from "chalk";\nexport const x = chalk;\n')];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("chalk", files, { ...graph, truncated: true }, new QueryEngine(graph));
    expect(impact.truncated).toBe(true);
  });

  it("skips a minified single-line bundle instead of scanning it", async () => {
    const padding = "x".repeat(2_100);
    const files = [f("bundle.js", `/*${padding}*/import chalk from "chalk";`)];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("chalk", files, graph, new QueryEngine(graph));
    expect(impact.importSites).toEqual([]);
  });

  it("is order-independent: import sites come back sorted by file then line", async () => {
    const files = [
      f("z.ts", 'import chalk from "chalk";\nexport const z = chalk;\n'),
      f("a.ts", '\nimport chalk from "chalk";\nexport const a = chalk;\n'),
    ];
    const graph = await buildSymbolGraph(files, new Map());
    const impact = replacementImpact("chalk", files, graph, new QueryEngine(graph));
    expect(impact.importSites.map((s) => `${s.file}:${s.line}`)).toEqual(["a.ts:2", "z.ts:1"]);
  });
});
