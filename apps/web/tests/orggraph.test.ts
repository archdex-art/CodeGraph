import { describe, expect, it } from "vitest";
import { buildOrgGraph, type OrgRepoInput } from "@/lib/orggraph";
import type { OwnershipReport } from "@/lib/types";

/**
 * The cross-repository graph.
 *
 * `buildOrgGraph` is pure over already-indexed results, so every case here is a fixture rather
 * than a repository — which is what makes it possible to state "B publishes the name A depends
 * on" precisely, and to write the negative case that matters: two repositories whose names
 * merely resemble each other must NOT be linked.
 */

function ownership(authors: Array<{ name: string; commits: number }>, files: Array<{ path: string; owner: string }> = []): OwnershipReport {
  return {
    authors: authors.map((a) => ({
      name: a.name,
      email: `${a.name.toLowerCase()}@x.example`,
      commits: a.commits,
      firstAt: 0,
      lastAt: 0,
      filesTouched: 1,
    })),
    files: files.map((f) => ({
      path: f.path,
      owners: [{ author: f.owner, share: 1, commits: 1, lastAt: 0 }],
      busFactor: 1,
      staleDays: 1,
      orphaned: false,
    })),
    symbols: [],
    windowDays: 180,
    commitsAnalysed: authors.reduce((s, a) => s + a.commits, 0),
    truncated: false,
  };
}

const repo = (over: Partial<OrgRepoInput> & { id: string }): OrgRepoInput => ({
  name: over.id,
  dependencies: [],
  packageNames: [],
  ...over,
});

describe("cross-repo dependency edges", () => {
  it("links A to B when B's manifest declares the package A depends on", () => {
    const g = buildOrgGraph([
      repo({ id: "app", dependencies: ["@acme/ui"] }),
      repo({ id: "ui", packageNames: ["@acme/ui"] }),
    ]);
    expect(g.edges).toEqual([{ from: "app", to: "ui", package: "@acme/ui", via: "manifest-name" }]);
  });

  it("draws NO edge for a package no repository publishes", () => {
    // The failure this prevents is an architecture diagram with invented edges. `react` is a
    // real dependency and not a cross-repo one, and nothing about the repo named `react-ish`
    // makes it the publisher.
    const g = buildOrgGraph([
      repo({ id: "app", dependencies: ["react"] }),
      repo({ id: "react-ish", packageNames: ["@acme/other"] }),
    ]);
    expect(g.edges).toEqual([]);
  });

  it("does not link a repo to itself for depending on its own sibling name", () => {
    const g = buildOrgGraph([repo({ id: "mono", dependencies: ["@acme/core"], packageNames: ["@acme/core"] })]);
    expect(g.edges).toEqual([]);
  });

  it("resolves two repos publishing the same name deterministically", () => {
    // A fork or a vendored copy. Either answer is defensible; an answer that depends on input
    // order is not, because the graph would change shape between two identical requests.
    const forward = buildOrgGraph([
      repo({ id: "app", dependencies: ["@acme/ui"] }),
      repo({ id: "aaa", packageNames: ["@acme/ui"] }),
      repo({ id: "zzz", packageNames: ["@acme/ui"] }),
    ]);
    const reversed = buildOrgGraph([
      repo({ id: "app", dependencies: ["@acme/ui"] }),
      repo({ id: "zzz", packageNames: ["@acme/ui"] }),
      repo({ id: "aaa", packageNames: ["@acme/ui"] }),
    ]);
    expect(forward.edges).toEqual(reversed.edges);
    expect(forward.edges[0]!.to).toBe("aaa");
  });
});

describe("shared libraries", () => {
  it("reports an external package two repos depend on, and marks it external", () => {
    const g = buildOrgGraph([
      repo({ id: "a", dependencies: ["lodash"] }),
      repo({ id: "b", dependencies: ["lodash"] }),
    ]);
    const shared = g.sharedLibraries.find((s) => s.package === "lodash")!;
    expect(shared.consumers).toEqual(["a", "b"]);
    expect(shared.internal).toBe(false);
    expect(shared.publishedBy).toBeNull();
  });

  it("marks a shared library internal and names its publisher", () => {
    const g = buildOrgGraph([
      repo({ id: "a", dependencies: ["@acme/ui"] }),
      repo({ id: "b", dependencies: ["@acme/ui"] }),
      repo({ id: "ui", packageNames: ["@acme/ui"] }),
    ]);
    const shared = g.sharedLibraries.find((s) => s.package === "@acme/ui")!;
    expect(shared.internal).toBe(true);
    expect(shared.publishedBy).toBe("ui");
  });

  it("does not call a package shared when only one repo uses it", () => {
    const g = buildOrgGraph([repo({ id: "a", dependencies: ["only-mine"] })]);
    expect(g.sharedLibraries).toEqual([]);
  });
});

describe("cycles between repositories", () => {
  it("detects a two-repo dependency cycle", () => {
    // Neither can be released without the other. A real and serious architectural finding, and
    // invisible on a page that renders each repository on its own.
    const g = buildOrgGraph([
      repo({ id: "a", dependencies: ["@acme/b"], packageNames: ["@acme/a"] }),
      repo({ id: "b", dependencies: ["@acme/a"], packageNames: ["@acme/b"] }),
    ]);
    expect(g.cycles).toEqual([["a", "b"]]);
  });

  it("reports no cycle for an acyclic chain", () => {
    const g = buildOrgGraph([
      repo({ id: "a", dependencies: ["@acme/b"], packageNames: ["@acme/a"] }),
      repo({ id: "b", dependencies: ["@acme/c"], packageNames: ["@acme/b"] }),
      repo({ id: "c", packageNames: ["@acme/c"] }),
    ]);
    expect(g.cycles).toEqual([]);
  });
});

describe("contributors", () => {
  it("merges one person's work across two repositories", () => {
    const g = buildOrgGraph([
      repo({ id: "a", packageNames: ["a"], ownership: ownership([{ name: "Ada", commits: 3 }]) }),
      repo({ id: "b", packageNames: ["b"], ownership: ownership([{ name: "Ada", commits: 2 }, { name: "Bob", commits: 1 }]) }),
    ]);
    const ada = g.contributors.find((c) => c.author === "Ada")!;
    expect(ada.commits).toBe(5);
    expect(ada.repos).toEqual(["a", "b"]);
  });

  it("records where an author is the top owner of a file", () => {
    const g = buildOrgGraph([
      repo({
        id: "a",
        packageNames: ["a"],
        ownership: ownership([{ name: "Ada", commits: 3 }], [{ path: "src/x.ts", owner: "Ada" }]),
      }),
    ]);
    expect(g.contributors.find((c) => c.author === "Ada")!.ownsIn).toEqual(["a"]);
  });

  it("does not re-canonicalise identity", () => {
    // `@codegraph/vcs` already merged name/email spellings. Doing it again here would give the
    // org view a second opinion, so the same person would appear once on a repo page and twice
    // on this one. Two spellings that arrived as two authors stay two authors.
    const g = buildOrgGraph([
      repo({ id: "a", packageNames: ["a"], ownership: ownership([{ name: "Ada Lovelace", commits: 1 }]) }),
      repo({ id: "b", packageNames: ["b"], ownership: ownership([{ name: "ada", commits: 1 }]) }),
    ]);
    expect(g.contributors.map((c) => c.author).sort()).toEqual(["Ada Lovelace", "ada"]);
  });
});

describe("what could not be included is named", () => {
  it("explains a repo indexed before ownership analysis existed", () => {
    const g = buildOrgGraph([repo({ id: "old", packageNames: ["old"] })]);
    const reason = g.excluded.find((e) => e.id === "old")!.reason;
    expect(reason).toMatch(/re-index/);
  });

  it("distinguishes an analysed-but-empty history from a missing analysis", () => {
    // Different facts, different actions: one needs a re-index, the other is simply a shallow
    // clone. Collapsing them into one message sends the reader to the wrong fix.
    const g = buildOrgGraph([repo({ id: "shallow", packageNames: ["shallow"], ownership: ownership([]) })]);
    const reason = g.excluded.find((e) => e.id === "shallow")!.reason;
    expect(reason).toMatch(/shallow clone|no commits/);
    expect(reason).not.toMatch(/re-index/);
  });

  it("explains a repo that publishes no name, since nothing can depend on it", () => {
    const g = buildOrgGraph([repo({ id: "app", dependencies: ["x"] })]);
    expect(g.excluded.find((e) => e.id === "app")!.reason).toMatch(/no manifest declares/);
  });
});

describe("viewer scoping is the caller's job, and the shape supports it", () => {
  it("contributes nothing at all for a repo that was not passed in", () => {
    /**
     * The route resolves each repository through `getRepo(id, viewer)`, so a private repo the
     * caller cannot see never reaches this function. This pins the consequence that matters:
     * omitting a repo must remove its NODE, its EDGES and its CONTRIBUTORS together. A partial
     * omission — dropping the node but leaving an edge pointing at it, or leaving its authors
     * in the contributor list — would leak the existence and the staffing of a repository the
     * caller is not allowed to know about.
     */
    const all = [
      repo({ id: "public", dependencies: ["@acme/secret"], packageNames: ["@acme/public"] }),
      repo({ id: "private", packageNames: ["@acme/secret"], ownership: ownership([{ name: "Mallory", commits: 9 }]) }),
    ];
    const scoped = buildOrgGraph(all.filter((r) => r.id !== "private"));

    expect(scoped.repos.map((r) => r.id)).toEqual(["public"]);
    expect(scoped.edges).toEqual([]);
    expect(scoped.contributors.map((c) => c.author)).not.toContain("Mallory");
    expect(JSON.stringify(scoped)).not.toContain("private");
    expect(JSON.stringify(scoped)).not.toContain("Mallory");
  });

  it("still sees the edge when both repos are visible", () => {
    // The control: without this, the test above would pass on a function that returns nothing.
    const visible = buildOrgGraph([
      repo({ id: "public", dependencies: ["@acme/secret"], packageNames: ["@acme/public"] }),
      repo({ id: "private", packageNames: ["@acme/secret"] }),
    ]);
    expect(visible.edges).toHaveLength(1);
  });
});
