import { describe, expect, it } from "vitest";
import { loadConfig } from "@codegraph/config";

/**
 * Indexing signed out writes `owner_id IS NULL`, and `authz.ts` treats that bucket as
 * world-readable and world-mutable. Reads were never the bug — a signed-in owner's
 * repos are already private, and the `VISIBLE` predicate is exhaustive and typed. The
 * bug was the DEFAULT IDENTITY on a shared deployment.
 *
 * What is pinned here is the DEFAULT, because that is the part an operator does not
 * choose. Anyone can set the flag wrong; nobody opts into a bad default, they inherit
 * it. The route-level 401 is one `if` over this value — this is the load-bearing half.
 */
describe("anonymous indexing default", () => {
  const load = (env: Record<string, string | undefined>) =>
    loadConfig({ NODE_ENV: "production", ...env });

  it("is OFF in production, so a shared deployment cannot leak by omission", () => {
    expect(load({}).allowAnonymousIndexing).toBe(false);
  });

  it("is ON outside production, so a self-hosted box needs no sign-in", () => {
    expect(load({ NODE_ENV: "development" }).allowAnonymousIndexing).toBe(true);
  });

  it("lets a trusted single-operator host opt back in", () => {
    expect(load({ CG_ALLOW_ANONYMOUS_INDEXING: "true" }).allowAnonymousIndexing).toBe(true);
  });

  it("lets a permissive dev default be opted OUT of", () => {
    expect(
      load({ NODE_ENV: "development", CG_ALLOW_ANONYMOUS_INDEXING: "false" }).allowAnonymousIndexing,
    ).toBe(false);
  });

  /**
   * The two capabilities answer the same question — "is this host shared?" — so a
   * deployment that hides its filesystem must not simultaneously invite anonymous
   * writes. Pinned as a relationship: if one default is ever retuned, this fails and
   * forces the other to be considered rather than silently diverging.
   */
  it("defaults in lockstep with local filesystem access", () => {
    for (const NODE_ENV of ["production", "development"]) {
      const c = load({ NODE_ENV });
      expect(c.allowAnonymousIndexing).toBe(c.allowLocalAccess);
    }
  });
});
