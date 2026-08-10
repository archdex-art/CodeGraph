import { describe, expect, it } from "vitest";
import { computeImportGraph, packageOf } from "../src/index";
import type { ScannedFile } from "@codegraph/analysis-model";

/**
 * Third-party imports, recorded rather than discarded.
 *
 * WHY THIS EXISTS. The resolution loop has always decided, per specifier, whether it names a
 * file in this repository — and dropped the ones that did not, which are exactly the
 * dependencies. `GraphNodeKind` has listed `"dependency"` and `GraphEdge.kind` `"depends"`
 * since the model was written and nothing produced either. Measured on this repository: 26
 * declared dependencies, 0 edges. So "what depends on lucide-react" answered "no file imports
 * it", which reads as an absence of dependencies rather than an absence of analysis.
 */
const f = (rel: string, ext: string, imports: string[]): ScannedFile =>
  ({ rel, ext, loc: 10, imports } as unknown as ScannedFile);

describe("packageOf", () => {
  it("takes the installable name, not the deep path", () => {
    expect(packageOf("lucide-react/icons/x")).toBe("lucide-react");
    expect(packageOf("@codegraph/core-graph/dist/x")).toBe("@codegraph/core-graph");
    expect(packageOf("express")).toBe("express");
  });
  it("is not fooled into calling the platform a dependency", () => {
    // `path` at the top of every repository's dependency chart is worse than no chart.
    for (const builtin of ["fs", "path", "node:fs", "node:test", "crypto"]) {
      expect(packageOf(builtin), builtin).toBeNull();
    }
  });

  it("excludes the Python standard library too", () => {
    // The first real run made these the five most-depended-upon "dependencies" of this repo.
    for (const std of ["__future__", "typing", "dataclasses", "collections", "sqlite3", "re"]) {
      expect(packageOf(std), std).toBeNull();
    }
    expect(packageOf("pytest")).toBe("pytest");
  });

  it("does not turn a build-tool path alias into a scoped package", () => {
    // `@/lib/store` is this repository's own source behind a tsconfig path mapping. A naive
    // scope split invents a package called `@/lib`.
    expect(packageOf("@/lib/store")).toBeNull();
    expect(packageOf("~/utils")).toBeNull();
    expect(packageOf("@scope/real")).toBe("@scope/real");
  });

  it("rejects anything that is not an installable specifier", () => {
    for (const s of ["./local", "../up", "/abs", "https://cdn/x.js", "#private", ""]) {
      expect(packageOf(s), s).toBeNull();
    }
  });

  it("does not mistake a scope for a package", () => {
    expect(packageOf("@scope")).toBeNull();
  });
});

describe("computeImportGraph records external dependencies", () => {
  it("separates a third-party import from a resolved local one", async () => {
    const r = await computeImportGraph([f("a.ts", ".ts", ["express", "./b"]), f("b.ts", ".ts", [])]);
    expect(r.externalEdges).toEqual([{ from: "a.ts", pkg: "express" }]);
    expect(r.importEdges).toEqual([{ from: "a.ts", to: "b.ts" }]);
  });

  it("records a package once per file however many statements import it", async () => {
    // The edge count must measure coupling, not how many import lines someone wrote.
    const r = await computeImportGraph([f("a.ts", ".ts", ["react", "react/jsx-runtime", "react"])]);
    expect(r.externalEdges).toEqual([{ from: "a.ts", pkg: "react" }]);
  });

  it("does not turn a broken relative import into a dependency", async () => {
    // `./missing` resolving to nothing is a bug in the repository, not a third-party package.
    const r = await computeImportGraph([f("a.ts", ".ts", ["./missing"])]);
    expect(r.externalEdges).toEqual([]);
  });

  it("reads a Go module path as host/owner/repo and skips the standard library", async () => {
    const r = await computeImportGraph([f("m.go", ".go", ["github.com/gorilla/mux", "net/http", "fmt"])]);
    expect(r.externalEdges.map((e) => e.pkg)).toEqual(["github.com/gorilla/mux"]);
  });

  it("does not call a local Go package external once it resolves inside the repo", async () => {
    const r = await computeImportGraph([
      f("cmd/main.go", ".go", ["example.com/me/app/internal/store"]),
      f("internal/store/store.go", ".go", []),
    ]);
    expect(r.externalEdges).toEqual([]);
    expect(r.importEdges).toEqual([{ from: "cmd/main.go", to: "internal/store/store.go" }]);
  });

  it("takes a Python top-level module and leaves relative imports alone", async () => {
    const r = await computeImportGraph([f("a.py", ".py", ["requests.adapters", ".sibling"])]);
    expect(r.externalEdges).toEqual([{ from: "a.py", pkg: "requests" }]);
  });
});
