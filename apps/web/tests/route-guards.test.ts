import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every repo-scoped route must enforce tenant isolation, checked STRUCTURALLY.
 *
 * `tenant-isolation.test.ts` covers named routes by hand, which means a route added tomorrow is
 * covered only by whoever remembers. That is the same shape as the gates this branch already
 * had to fix: a check that cannot tell you what it skipped is not a check. The SARIF download
 * route added in this branch was guarded because I thought to do it, not because anything would
 * have failed if I had not.
 *
 * Two guards are legitimate. `repoAccessDenied(req, id)` is the direct form; `requireWorkspace`
 * wraps it and additionally resolves the workspace directory. Anything under `repos/[id]/` that
 * uses neither can serve one tenant's analysis to another.
 */
const API_ROOT = path.resolve(__dirname, "../src/app/api");
const REPO_SCOPED = path.join(API_ROOT, "repos", "[id]");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("repo-scoped routes enforce tenant isolation", () => {
  const files = routeFiles(REPO_SCOPED);

  it("finds routes to check, so the suite cannot pass by enumerating nothing", () => {
    // Without this, a broken path makes every assertion below vacuous and the file reports
    // green while checking zero routes.
    expect(files.length).toBeGreaterThan(8);
  });

  it.each(files.map((f) => [path.relative(API_ROOT, f), f]))(
    "%s calls a tenant guard",
    (_label, file) => {
      const src = readFileSync(file, "utf8");
      const guarded = /\brepoAccessDenied\s*\(/.test(src) || /\brequireWorkspace\s*\(/.test(src);
      expect(guarded).toBe(true);
    },
  );

  it("checks the guard is actually invoked, not merely imported", () => {
    // An import with no call is the failure this would otherwise wave through.
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const importsOnly =
        /import[^;]*\b(repoAccessDenied|requireWorkspace)\b[^;]*;/.test(src) &&
        !/\b(repoAccessDenied|requireWorkspace)\s*\(/.test(src);
      expect(importsOnly, `${path.relative(API_ROOT, file)} imports a guard but never calls it`).toBe(false);
    }
  });
});
