import type { Migration } from "../migration-type";

/**
 * `repos.package_names_json` — the names a repository PUBLISHES.
 *
 * `deps` already stores what a repository consumes. This is the other direction, and the
 * cross-repo graph cannot exist without it: an edge from A to B is drawn when A depends on a
 * package name that B's own manifest declares, and that is the only evidence that makes the
 * edge a fact rather than a guess. Matching a dependency against a repository's slug or
 * directory name — the alternative when this is unavailable — invents a link whenever two
 * things happen to share a word, which is worse than showing no link at all.
 *
 * A SEPARATE MIGRATION rather than a sixth column on 007, even though the two were written
 * minutes apart: 007 has already been applied to running databases in this workspace, and the
 * runner records a version once. Editing an applied migration is the one thing LLD §8.2 forbids
 * — the database that already ran it would never see the change, and the two would diverge in
 * silence. Append-only means append-only regardless of how recent the predecessor is.
 *
 * NULL means the run predates this, which readers treat as "this repository declares no name we
 * know of" and therefore as a repo nothing can depend on BY NAME — reported in the org graph's
 * `excluded` list with that reason, never silently omitted.
 */
export const migration008: Migration = {
  version: 8,
  name: "package_names",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "package_names_json")) return;
    db.exec("ALTER TABLE repos ADD COLUMN package_names_json TEXT");
  },
};
