import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withinLocalAccessRoot } from "@/lib/localAccess";

/**
 * `CG_LOCAL_ACCESS_ROOT` is the defence-in-depth boundary under `localAccessAllowed()`:
 * it narrows what a local-access opt-in actually covers, so a misconfigured deployment
 * does not mean whole-disk exposure.
 *
 * It was enforced on `/api/browse` and NOT on `/api/index`, which is backwards. Browse
 * discloses directory NAMES; indexing walks the tree and makes file CONTENTS readable
 * through the repo's fs/search/editor endpoints. The stronger capability was the
 * unguarded one.
 */
const env = process.env as Record<string, string | undefined>;
const ORIGINAL_ROOT = env.CG_LOCAL_ACCESS_ROOT;
const dirs: string[] = [];

function freshRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cg-lar-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete env.CG_LOCAL_ACCESS_ROOT;
  else env.CG_LOCAL_ACCESS_ROOT = ORIGINAL_ROOT;
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("withinLocalAccessRoot", () => {
  it("allows anything when no root is configured, preserving the default deployment", () => {
    delete env.CG_LOCAL_ACCESS_ROOT;
    expect(withinLocalAccessRoot("/etc")).toBe(true);
    expect(withinLocalAccessRoot("/")).toBe(true);
  });

  it("allows the root itself and paths inside it", () => {
    const root = freshRoot();
    mkdirSync(path.join(root, "project"), { recursive: true });
    env.CG_LOCAL_ACCESS_ROOT = root;
    expect(withinLocalAccessRoot(root)).toBe(true);
    expect(withinLocalAccessRoot(path.join(root, "project"))).toBe(true);
    // A path that does not exist yet is judged lexically, not refused outright.
    expect(withinLocalAccessRoot(path.join(root, "not-created-yet"))).toBe(true);
  });

  it("refuses paths outside the root", () => {
    const root = freshRoot();
    env.CG_LOCAL_ACCESS_ROOT = root;
    expect(withinLocalAccessRoot("/etc")).toBe(false);
    expect(withinLocalAccessRoot(path.join(root, ".."))).toBe(false);
    expect(withinLocalAccessRoot(path.join(root, "..", "elsewhere"))).toBe(false);
  });

  it("refuses a sibling directory whose name merely starts with the root", () => {
    const root = freshRoot();
    env.CG_LOCAL_ACCESS_ROOT = root;
    expect(withinLocalAccessRoot(root + "-evil")).toBe(false);
  });

  it("refuses a symlink inside the root that points outside it", () => {
    const root = freshRoot();
    const outside = freshRoot();
    symlinkSync(outside, path.join(root, "escape"));
    env.CG_LOCAL_ACCESS_ROOT = root;
    expect(withinLocalAccessRoot(path.join(root, "escape"))).toBe(false);
  });
});

describe("every local-path entry point enforces the root", () => {
  /**
   * Structural, because the bug was an ENTRY POINT that skipped the check, not a wrong
   * check. A behavioural test of `/api/browse` would have stayed green through the whole
   * incident. What has to be true is that no route accepts a caller-supplied local path
   * without consulting the boundary.
   */
  const routes = ["src/app/api/browse/route.ts", "src/app/api/index/route.ts"];

  it.each(routes)("%s calls withinLocalAccessRoot", (rel) => {
    const source = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    expect(source).toContain("localAccessAllowed()");
    expect(source).toContain("withinLocalAccessRoot(");
  });
});
