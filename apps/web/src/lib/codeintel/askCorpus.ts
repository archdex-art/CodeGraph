import type { AskCorpus } from "@codegraph/core-graph";
import type { RepoDetail } from "@/lib/types";

/**
 * Adapt an indexed repository into the shape the query compiler reads.
 *
 * WHY THIS ADAPTER EXISTS RATHER THAN THE COMPILER READING `RepoDetail`
 *
 * `@codegraph/core-graph` may only depend on `@codegraph/core-domain`
 * (`.dependency-cruiser.cjs`), so it cannot see `VizGraph` — which is where external packages
 * and file-to-file imports live. Rather than widen that boundary for one consumer, the
 * compiler declares the two maps it needs and this function derives them here.
 *
 * The boundary turns out to be the right one on its own merits: the compiler should not know
 * that `dep:redis` is how a rendering model spells an external package, and moving that detail
 * out means a future storage change is a change to this file alone.
 */

/** How `VizGraph` names an external package node. */
const DEP_PREFIX = "dep:";

export function askCorpus(repo: RepoDetail): AskCorpus {
  const packageImporters = new Map<string, string[]>();
  const fileImporters = new Map<string, string[]>();

  for (const e of repo.viz.edges) {
    if (e.kind === "depends" && e.target.startsWith(DEP_PREFIX)) {
      // `depends` runs file -> package, so the importer is the source.
      const pkg = e.target.slice(DEP_PREFIX.length);
      const list = packageImporters.get(pkg);
      if (list) list.push(e.source);
      else packageImporters.set(pkg, [e.source]);
    } else if (e.kind === "imports") {
      // Inverted on purpose: the compiler walks UPWARD from a file to the files that reach it,
      // so it needs importers-of, not imports-of. Building the reverse index once here keeps
      // that walk linear instead of rescanning every edge per hop.
      const list = fileImporters.get(e.target);
      if (list) list.push(e.source);
      else fileImporters.set(e.target, [e.source]);
    }
  }

  /*
   * A package the manifest declares but no file imports must still be answerable: "what depends
   * on leftpad" should say "nothing here uses it", which is a finding, and it cannot say that
   * if the package is absent from the map and resolves as an unknown entity instead.
   */
  for (const name of repo.dependencies) {
    if (!packageImporters.has(name)) packageImporters.set(name, []);
  }

  return {
    graph: repo.symbolGraph,
    ...(repo.apiSurface ? { api: repo.apiSurface } : {}),
    /*
     * Passed straight through, not mapped. `AskOwnership` is declared as a structural SUBSET of
     * `OwnershipReport` precisely so this line stays a spread rather than a translation - a
     * field renamed upstream becomes a type error here instead of a silently empty answer.
     */
    ...(repo.ownership ? { ownership: repo.ownership } : {}),
    packageImporters,
    fileImporters,
  };
}
