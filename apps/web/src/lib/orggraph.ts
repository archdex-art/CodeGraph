import type { AuthorStat, OwnershipReport } from "./types";

/**
 * The organisational knowledge graph: how repositories relate to each other.
 *
 * Everything the Fleet page shows today is per-repo aggregation — N independent scores in one
 * table — and nothing in the product relates two repositories at all. This derives that layer
 * from results that are ALREADY indexed, so it costs no re-analysis: the inputs are stored
 * `IndexResult`s, and a caller that can list repositories can build the whole graph.
 *
 * THE RULE THIS OBEYS, and the reason `via` exists on every edge: a link is only drawn from
 * evidence in a manifest. Repo A depends on package `P`, and some repo B's own manifest
 * DECLARES the name `P` — that is a fact about two files. The tempting alternative, matching a
 * dependency against a repository's slug or directory name, invents a link whenever two things
 * happen to share a word, and an architecture diagram with invented edges is worse than none:
 * it is confidently wrong about the shape of the system, which is precisely what the reader
 * came for.
 *
 * WHAT IT CANNOT SEE. A repository whose index predates ownership analysis contributes no
 * contributors, and one whose manifest declares no name cannot be the target of an edge. Both
 * are reported in `excluded` with a reason rather than silently dropped, because a graph
 * missing a node looks exactly like a system that does not have one.
 */

/** Repositories folded into one graph. Beyond this the answer is a fleet report, not a graph. */
const MAX_REPOS = 500;

/** Dependencies read per repository. A generated manifest can declare thousands. */
const MAX_DEPS_PER_REPO = 2_000;

/** Contributors carried out. Sorted by commits, so the cap drops the least active. */
const MAX_CONTRIBUTORS = 500;

/** Cycles reported. One is a finding; twenty is a wall. */
const MAX_CYCLES = 20;

export interface OrgRepo {
  readonly id: string;
  readonly name: string;
  /** Package names this repository's own manifests declare. Empty when it publishes none. */
  readonly packageNames: readonly string[];
  readonly dependencies: readonly string[];
}

export interface CrossRepoEdge {
  /** Repo id that declares the dependency. */
  readonly from: string;
  /** Repo id whose manifest declares the package name. */
  readonly to: string;
  readonly package: string;
  /**
   * How the link was established. One value today, and it is here so the basis is always
   * visible: a future heuristic (a lockfile resolution, a registry lookup) must not be
   * indistinguishable from a manifest fact.
   */
  readonly via: "manifest-name";
}

export interface SharedLibrary {
  readonly package: string;
  /** Repo ids depending on it, sorted. */
  readonly consumers: readonly string[];
  /** Published by a repository in this set, as opposed to coming from a registry. */
  readonly internal: boolean;
  readonly publishedBy: string | null;
}

export interface OrgContributor {
  readonly author: string;
  /** Repo ids this author has commits in, sorted. */
  readonly repos: readonly string[];
  readonly commits: number;
  /** Repos where this author is the top owner of at least one file. */
  readonly ownsIn: readonly string[];
}

export interface OrgGraph {
  readonly repos: readonly OrgRepo[];
  readonly edges: readonly CrossRepoEdge[];
  readonly sharedLibraries: readonly SharedLibrary[];
  readonly contributors: readonly OrgContributor[];
  /** Dependency cycles BETWEEN repositories, each a list of repo ids. */
  readonly cycles: readonly (readonly string[])[];
  /** Repos that could not contribute, and why. Named, never silently dropped. */
  readonly excluded: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  readonly truncated: boolean;
}

/** The slice of an indexed result this needs. Structural, so a caller passes `RepoDetail`. */
export interface OrgRepoInput {
  readonly id: string;
  readonly name: string;
  readonly dependencies: readonly string[];
  /**
   * Names this repository's own manifests declare.
   *
   * Separate from `dependencies` and REQUIRED to be evidence-derived: this is what makes a
   * repository the target of an edge, so guessing it from the slug would manufacture links.
   */
  readonly packageNames: readonly string[];
  /** Absent when the run predates ownership analysis — a different thing from empty. */
  readonly ownership?: OwnershipReport | undefined;
}

/**
 * Cycles over the repo dependency graph, via iterative Tarjan.
 *
 * Iterative rather than recursive because the input is an arbitrary org: a deep chain would
 * blow the stack, and this runs in a request. A cycle between two repositories is a genuine
 * and serious architectural finding — it means neither can be released without the other — so
 * it is surfaced rather than left for a reader to spot in a diagram.
 */
function repoCycles(nodes: readonly string[], edges: readonly CrossRepoEdge[]): string[][] {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to) continue; // a workspace depending on its own sibling is not a cycle
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let idx = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    index.set(root, idx);
    low.set(root, idx);
    idx++;
    stack.push(root);
    onStack.add(root);
    const frames: [string, number][] = [[root, 0]];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const [v] = frame;
      const targets = out.get(v) ?? [];
      let descended = false;

      for (let j = frame[1]; j < targets.length; j++) {
        const w = targets[j]!;
        frame[1] = j + 1;
        if (!index.has(w)) {
          index.set(w, idx);
          low.set(w, idx);
          idx++;
          stack.push(w);
          onStack.add(w);
          frames.push([w, 0]);
          descended = true;
          break;
        }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (descended) continue;

      frames.pop();
      const parent = frames[frames.length - 1]?.[0];
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(v)!));

      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1 && cycles.length < MAX_CYCLES) cycles.push(comp.sort());
      }
    }
  }
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

export function buildOrgGraph(inputs: readonly OrgRepoInput[]): OrgGraph {
  const excluded: Array<{ id: string; reason: string }> = [];
  let truncated = false;

  const considered = inputs.slice(0, MAX_REPOS);
  if (considered.length < inputs.length) truncated = true;

  const repos: OrgRepo[] = considered.map((r) => {
    const deps = r.dependencies.slice(0, MAX_DEPS_PER_REPO);
    if (deps.length < r.dependencies.length) truncated = true;
    return {
      id: r.id,
      name: r.name,
      packageNames: [...r.packageNames].sort(),
      dependencies: [...deps].sort(),
    };
  });

  // Who publishes what. A Map because the key is a package name out of somebody's manifest —
  // `Record` would resolve `"constructor"` to `Object.prototype.constructor`.
  const publisher = new Map<string, string>();
  for (const r of considered) {
    for (const name of r.packageNames) {
      // First declarer wins, deterministically by repo id, so two repos publishing the same
      // name (a fork, a vendored copy) do not make the graph depend on input order.
      const existing = publisher.get(name);
      if (existing === undefined || r.id < existing) publisher.set(name, r.id);
    }
    if (r.packageNames.length === 0) {
      excluded.push({
        id: r.id,
        reason: "no manifest declares a package name — nothing can depend on it by name",
      });
    }
  }

  // ── Cross-repo edges ──────────────────────────────────────────────────────────────────
  const edges: CrossRepoEdge[] = [];
  for (const r of repos) {
    for (const pkg of r.dependencies) {
      const to = publisher.get(pkg);
      // No publisher means an external package: a real dependency, but not a cross-repo edge.
      if (to === undefined || to === r.id) continue;
      edges.push({ from: r.id, to, package: pkg, via: "manifest-name" });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.package.localeCompare(b.package));

  // ── Shared libraries ──────────────────────────────────────────────────────────────────
  const consumersOf = new Map<string, string[]>();
  for (const r of repos) {
    for (const pkg of r.dependencies) {
      const list = consumersOf.get(pkg);
      if (list) list.push(r.id);
      else consumersOf.set(pkg, [r.id]);
    }
  }
  const sharedLibraries: SharedLibrary[] = [];
  for (const [pkg, consumers] of consumersOf) {
    if (consumers.length < 2) continue;
    const publishedBy = publisher.get(pkg) ?? null;
    sharedLibraries.push({
      package: pkg,
      consumers: [...consumers].sort(),
      internal: publishedBy !== null,
      publishedBy,
    });
  }
  sharedLibraries.sort((a, b) => b.consumers.length - a.consumers.length || a.package.localeCompare(b.package));

  // ── Contributors ──────────────────────────────────────────────────────────────────────
  /**
   * Identity is whatever `@codegraph/vcs` decided.
   *
   * It already canonicalises across name and email spellings, and re-doing that here would give
   * the org view a second opinion about who someone is — so the same person would appear once
   * on a repo page and twice on this one. The names in an `OwnershipReport` are authoritative.
   */
  const byAuthor = new Map<string, { commits: number; repos: Set<string>; ownsIn: Set<string> }>();
  for (const r of considered) {
    if (!r.ownership) {
      excluded.push({
        id: r.id,
        reason: "indexed before ownership analysis existed — re-index to include its contributors",
      });
      continue;
    }
    if (r.ownership.authors.length === 0) {
      // A different statement from the one above, and the distinction matters: this repository
      // WAS analysed. A shallow clone or a window with no commits genuinely has no authors.
      excluded.push({
        id: r.id,
        reason: "analysed, but its history window contains no commits (shallow clone, or inactive)",
      });
      continue;
    }
    for (const a of r.ownership.authors as readonly AuthorStat[]) {
      let entry = byAuthor.get(a.name);
      if (!entry) {
        entry = { commits: 0, repos: new Set(), ownsIn: new Set() };
        byAuthor.set(a.name, entry);
      }
      entry.commits += a.commits;
      entry.repos.add(r.id);
    }
    for (const file of r.ownership.files) {
      const top = file.owners[0];
      if (top) byAuthor.get(top.author)?.ownsIn.add(r.id);
    }
  }
  const contributors: OrgContributor[] = [...byAuthor.entries()]
    .map(([author, v]) => ({
      author,
      commits: v.commits,
      repos: [...v.repos].sort(),
      ownsIn: [...v.ownsIn].sort(),
    }))
    .sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author));
  if (contributors.length > MAX_CONTRIBUTORS) truncated = true;

  return {
    repos,
    edges,
    sharedLibraries,
    contributors: contributors.slice(0, MAX_CONTRIBUTORS),
    cycles: repoCycles(repos.map((r) => r.id), edges),
    excluded: excluded.sort((a, b) => a.id.localeCompare(b.id)),
    truncated,
  };
}
