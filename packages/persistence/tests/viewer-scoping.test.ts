import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { viewerId } from "@codegraph/core-domain";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-viewer-scoping-"));
process.env["CG_DATA_DIR"] = dataDir;

const {
  db,
  deleteRepo,
  findRepo,
  findRepoUnscoped,
  insertRepo,
  listRepos,
  repoOwnerId,
} = await import("../src/index");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Tenant isolation, enforced in persistence rather than remembered per route
 * (LLD §8).
 *
 * v1's rule lived in `repoAccessDenied`, called at the top of each route. That is
 * correct today and one new route away from a cross-account leak. These tests
 * assert the property at the layer that now owns it, so a route that forgets its
 * check still cannot read another account's repo.
 *
 * The model, unchanged: `owner_id IS NULL` is a shared public bucket anyone may
 * read; anything else is private to that account, and a non-owner sees exactly
 * what they would see for a repo that does not exist.
 */

const ALICE = viewerId(1001);
const BOB = viewerId(2002);
const ANONYMOUS = viewerId(null);

beforeEach(() => {
  db().exec("DELETE FROM repos");
  insertRepo({ id: "public-repo", url: "https://github.com/o/pub", name: "o/pub", sourceType: "git", ownerId: null, createdAt: 1 });
  insertRepo({ id: "alice-repo", url: "https://github.com/o/alice", name: "o/alice", sourceType: "git", ownerId: 1001, createdAt: 2 });
  insertRepo({ id: "bob-repo", url: "https://github.com/o/bob", name: "o/bob", sourceType: "git", ownerId: 2002, createdAt: 3 });
});

describe("findRepo is scoped by viewer", () => {
  it("lets the owner read their own private repo", () => {
    expect(findRepo("alice-repo", ALICE)?.id).toBe("alice-repo");
  });

  it("hides another account's private repo", () => {
    expect(findRepo("alice-repo", BOB)).toBeNull();
  });

  it("hides a private repo from an anonymous viewer", () => {
    expect(findRepo("alice-repo", ANONYMOUS)).toBeNull();
  });

  it("gives everyone the public bucket", () => {
    expect(findRepo("public-repo", ALICE)?.id).toBe("public-repo");
    expect(findRepo("public-repo", BOB)?.id).toBe("public-repo");
    expect(findRepo("public-repo", ANONYMOUS)?.id).toBe("public-repo");
  });

  it("returns null for a nonexistent repo, indistinguishably from a hidden one", () => {
    // The 404-not-403 decision, at the data layer: a denial must look exactly
    // like absence or the response discloses that the repo exists.
    expect(findRepo("no-such-repo", ALICE)).toBeNull();
    expect(findRepo("alice-repo", BOB)).toBeNull();
  });

  it("does not treat a signed-out viewer as owning rows with a NULL owner match", () => {
    // The bug this guards: binding `null` into `owner_id = ?` makes the
    // comparison never match, which would ALSO hide the viewer's own repos. The
    // sentinel has to be a value no real account id can equal.
    expect(findRepo("alice-repo", ANONYMOUS)).toBeNull();
    expect(findRepo("public-repo", ANONYMOUS)).not.toBeNull();
  });
});

describe("listRepos is scoped by viewer", () => {
  it("shows an owner the public bucket plus their own", () => {
    expect(listRepos(ALICE).map((r) => r.id).sort()).toEqual(["alice-repo", "public-repo"]);
  });

  it("shows an anonymous viewer only the public bucket", () => {
    expect(listRepos(ANONYMOUS).map((r) => r.id)).toEqual(["public-repo"]);
  });

  it("never leaks another account's repo into a listing", () => {
    for (const viewer of [ALICE, ANONYMOUS]) {
      expect(listRepos(viewer).map((r) => r.id)).not.toContain("bob-repo");
    }
  });
});

describe("deleteRepo is scoped by viewer", () => {
  it("lets the owner delete their own repo", () => {
    expect(deleteRepo("alice-repo", ALICE)).toBe(true);
    expect(findRepoUnscoped("alice-repo")).toBeNull();
  });

  it("refuses to delete another account's repo, and leaves the row intact", () => {
    // Reading someone else's repo being impossible is worth little if deleting
    // it is not.
    expect(deleteRepo("alice-repo", BOB)).toBe(false);
    expect(findRepoUnscoped("alice-repo")).not.toBeNull();
  });

  it("refuses anonymous deletion of a private repo", () => {
    expect(deleteRepo("alice-repo", ANONYMOUS)).toBe(false);
    expect(findRepoUnscoped("alice-repo")).not.toBeNull();
  });

  it("allows anyone to delete from the public bucket, matching v1", () => {
    // Deliberately unchanged: the public bucket has always been mutable by
    // anyone. Tightening it here would be a behaviour change, not a fix.
    expect(deleteRepo("public-repo", ANONYMOUS)).toBe(true);
  });

  it("does not delete a non-owner's jobs as a side effect of a refused delete", () => {
    db().prepare("INSERT INTO jobs (id, repo_id, status) VALUES ('j1', 'alice-repo', 'done')").run();
    expect(deleteRepo("alice-repo", BOB)).toBe(false);
    expect(db().prepare("SELECT id FROM jobs WHERE id='j1'").get()).toBeDefined();
  });
});

describe("the unscoped escape hatch", () => {
  it("findRepoUnscoped ignores ownership, by design", () => {
    // For the background job runner and the timeline engine, which act as the
    // system and must write results back to a private repo. Named so every such
    // read is greppable rather than reachable by omitting an argument.
    expect(findRepoUnscoped("alice-repo")?.id).toBe("alice-repo");
    expect(findRepoUnscoped("bob-repo")?.id).toBe("bob-repo");
  });

  it("repoOwnerId distinguishes public, owned, and absent", () => {
    // Three-valued on purpose: `null` (public) and `undefined` (no such repo)
    // must not collapse, because authz treats them differently — public is open
    // to everyone, absent is a 404.
    expect(repoOwnerId("public-repo")).toBeNull();
    expect(repoOwnerId("alice-repo")).toBe(1001);
    expect(repoOwnerId("no-such-repo")).toBeUndefined();
  });
});
