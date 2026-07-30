import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * Dependency hygiene across every manifest, not just the root one.
 *
 * THE BUG. `analyzeDependencies` read `path.join(root, "package.json")` and nothing else. On a
 * workspaces monorepo that is the thinnest manifest in the tree — measured on CodeGraph itself:
 * the root declares 3 dependencies, the 18 workspace manifests declare 36 distinct external
 * packages between them. 33 of 36 were invisible, and the dimension scored a clean 100 over 3
 * packages. After the fix: 36 found, 36 declared, 6 real findings.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-deps-"));
  trees.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const deps = (r: Awaited<ReturnType<typeof indexRepo>>) => r.dependencies;

describe("manifest discovery", () => {
  it("aggregates dependencies from nested workspace manifests", async () => {
    const r = await indexRepo(
      repo({
        "package.json": { name: "root", devDependencies: { typescript: "^5.0.0" } },
        "packages/a/package.json": { name: "@x/a", dependencies: { lodash: "^4.0.0" } },
        "packages/b/package.json": { name: "@x/b", dependencies: { zod: "^3.0.0" } },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(deps(r).sort()).toEqual(["lodash", "typescript", "zod"]);
  });

  it("counts a dependency shared by several workspaces ONCE", async () => {
    // Counting declarations rather than packages makes a monorepo look N times heavier.
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/a/package.json": { name: "@x/a", dependencies: { zod: "^3.0.0" } },
        "packages/b/package.json": { name: "@x/b", dependencies: { zod: "^3.0.0" } },
        "packages/c/package.json": { name: "@x/c", dependencies: { zod: "^3.0.0" } },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(deps(r)).toEqual(["zod"]);
    expect(r.graphStats.dependencies).toBe(1);
  });

  it("excludes workspace-internal packages", async () => {
    // A workspace depending on a sibling is structure, not supply chain.
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/a/package.json": { name: "@x/a", dependencies: { zod: "^3.0.0" } },
        "packages/b/package.json": { name: "@x/b", dependencies: { "@x/a": "*", lodash: "^4.0.0" } },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(deps(r).sort()).toEqual(["lodash", "zod"]);
    expect(deps(r)).not.toContain("@x/a");
  });

  it("recognises a sibling as internal regardless of manifest order", async () => {
    // The dependant is read before the package it names, so a single pass would miss it.
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/aaa/package.json": { name: "@x/zzz", dependencies: { "@x/aaa": "*" } },
        "packages/zzz/package.json": { name: "@x/aaa" },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(deps(r)).toEqual([]);
  });

  it("does NOT report a nested repository's dependencies as this project's", async () => {
    // The manifests come from the scanned file list, which excludes nested repos. Without that
    // inheritance this would claim a cloned target repo's supply chain as its own — five such
    // clones were sitting in this checkout while the fix was written.
    const root = repo({
      "package.json": { name: "root", dependencies: { zod: "^3.0.0" } },
      "src/index.ts": "export const a = 1;\n",
      "clones/other/package.json": { name: "other", dependencies: { "left-pad": "1.0.0" } },
    });
    mkdirSync(path.join(root, "clones/other/.git"), { recursive: true });
    const r = await indexRepo(root);
    expect(deps(r)).toEqual(["zod"]);
    expect(deps(r)).not.toContain("left-pad");
  });
});

describe("hygiene findings", () => {
  it("attributes an unpinned dependency to the manifest that declares it", async () => {
    // Every finding used to point at the literal string "package.json".
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/a/package.json": { name: "@x/a", dependencies: { sloppy: "*" } },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    const found = r.issues.find((i) => i.title.includes("sloppy"));
    expect(found?.file).toBe("packages/a/package.json");
  });

  it("does not flag `*` on a workspace-internal package", async () => {
    // `"@x/a": "*"` is the ordinary way to reference a sibling; flagging it as unpinned is
    // noise, which is why the internal check runs first.
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/a/package.json": { name: "@x/a" },
        "packages/b/package.json": { name: "@x/b", dependencies: { "@x/a": "*" } },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(r.issues.filter((i) => i.title.includes("Unpinned"))).toEqual([]);
  });

  it("reports a malformed manifest instead of crashing", async () => {
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/a/package.json": "{ not valid json",
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(r.issues.some((i) => i.title === "Unparseable package.json")).toBe(true);
  });

  it("checks for a lockfile once, at the root", async () => {
    // One root lockfile covers every workspace member; demanding one per manifest would
    // report a problem that does not exist.
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "packages/a/package.json": { name: "@x/a" },
        "packages/b/package.json": { name: "@x/b" },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(r.issues.filter((i) => i.title === "No lockfile committed")).toHaveLength(1);
  });

  it("is satisfied by a root lockfile", async () => {
    const r = await indexRepo(
      repo({
        "package.json": { name: "root" },
        "package-lock.json": "{}",
        "packages/a/package.json": { name: "@x/a" },
        "src/index.ts": "export const a = 1;\n",
      }),
    );
    expect(r.issues.filter((i) => i.title === "No lockfile committed")).toEqual([]);
  });
});
