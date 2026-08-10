import { describe, expect, it } from "vitest";
import { moduleOf, resolveOpenIds, moduleMembers } from "@/lib/moduleScope";
import { ALL_MODULES } from "@/lib/graph-url";

/**
 * THE BUG THIS EXISTS TO STOP COMING BACK.
 *
 * The network view drew a module box for every top-level directory, and `moduleOf` maps a file
 * with no directory to itself. So a repository root holding `package-lock.json` produced a module
 * whose id IS that file's id. Opening it emitted both - the module and the one file inside it -
 * and React reported "Encountered two children with the same key, `package-lock.json`". On screen
 * the two cards sat on top of each other.
 *
 * The assertions below are written as the invariant that was violated (no id is drawn twice)
 * rather than as the two filters that now hold it, so a future rewrite of the filters is still
 * measured against the thing that actually broke.
 */

/** Every id the view would render for a given `?open=` - modules on the canvas, plus members. */
function drawnIds(files: readonly { id: string }[], open: string | null): string[] {
  const sizes = new Map<string, number>();
  for (const f of files) sizes.set(moduleOf(f.id), (sizes.get(moduleOf(f.id)) ?? 0) + 1);
  const all = [...sizes].map(([id, n]) => ({ id, files: n }));

  const openIds = resolveOpenIds(open, all);
  const openSet = new Set(openIds);
  // Opening one module hides the others; opening all of them keeps every module on screen.
  const pool = openSet.size > 1 || !openSet.size ? all : all.filter((m) => openSet.has(m.id));
  return [...pool.map((m) => m.id), ...openIds.flatMap((id) => moduleMembers(files, id).map((f) => f.id))];
}

const REPO = [
  { id: "package-lock.json" },
  { id: "README.md" },
  { id: "src/index.ts" },
  { id: "src/util.ts" },
  { id: "docs/a.md" },
  { id: "docs/b.md" },
];

describe("module scope", () => {
  it("never draws one id twice, whatever the URL asks to open", () => {
    for (const open of [null, "", ALL_MODULES, "package-lock.json", "README.md", "src", "docs", "nope"]) {
      const ids = drawnIds(REPO, open);
      expect(new Set(ids).size, `duplicate id for ?open=${open}`).toBe(ids.length);
    }
  });

  it("refuses to open a module that is a single root file", () => {
    // The expand affordance is hidden for these; a hand-typed or stale link reached them anyway.
    expect(resolveOpenIds("package-lock.json", [{ id: "package-lock.json", files: 1 }])).toEqual([]);
  });

  it("still opens a module that has an inside", () => {
    expect(resolveOpenIds("src", [{ id: "src", files: 2 }])).toEqual(["src"]);
  });

  it("expands the sentinel to only the modules with an inside", () => {
    const all = [{ id: "src", files: 2 }, { id: "README.md", files: 1 }, { id: "docs", files: 9 }];
    expect(resolveOpenIds(ALL_MODULES, all)).toEqual(["src", "docs"]);
  });

  it("drops an id that names no module, rather than emptying the canvas", () => {
    expect(resolveOpenIds("deleted-since-the-link-was-shared", [{ id: "src", files: 2 }])).toEqual([]);
    expect(drawnIds(REPO, "nope")).toContain("src");
  });

  it("excludes the file whose id equals the module's, when a file and a directory share a name", () => {
    // Legal on disk: a `docs` file beside a `docs/` directory. They merge into one openable
    // module, and its members would otherwise include the file carrying the module's own id.
    const files = [{ id: "docs" }, { id: "docs/a.md" }, { id: "docs/b.md" }];
    expect(resolveOpenIds("docs", [{ id: "docs", files: 3 }])).toEqual(["docs"]);
    expect(moduleMembers(files, "docs").map((f) => f.id)).toEqual(["docs/a.md", "docs/b.md"]);
    const ids = drawnIds(files, "docs");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("groups a file with no directory under its own name, and a nested one under its top level", () => {
    expect(moduleOf("package-lock.json")).toBe("package-lock.json");
    expect(moduleOf("apps/web/src/index.ts")).toBe("apps");
  });
});
