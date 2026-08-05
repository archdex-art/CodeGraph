import { defineConfig } from "vitest/config";

/**
 * Vitest root (LLD §1 calls this `vitest.workspace.ts`).
 *
 * Uses `test.projects` rather than a `vitest.workspace.ts` file because Vitest
 * 3.2 deprecates the latter and prints a warning on every run; a permanent
 * warning in CI output is how real warnings stop being read. Same semantics,
 * same per-project configs.
 *
 * Each project keeps its own `vitest.config.ts` so a package's tests run in
 * isolation (`npm test -w @codegraph/core-domain`) as well as from the root —
 * HLD §3 "Testability" wants every unit runnable on its own, which a single
 * merged `include` would quietly take away.
 */
export default defineConfig({
  test: {
    // Listed explicitly rather than widened to `apps/*`. The reason was `apps/desktop`,
    // which ran its own Vitest and a Playwright suite a root glob would have tried to
    // collect; that app has been removed. Kept explicit anyway — an app that wants its
    // tests run from the root should have to say so.
    projects: ["apps/cli", "apps/web", "apps/worker", "packages/*"],
  },
});
