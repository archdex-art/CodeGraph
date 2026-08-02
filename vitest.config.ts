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
    // `apps/worker` is listed explicitly rather than widening to `apps/*`, because
    // `apps/desktop` must NOT be picked up here: it runs its own Vitest with a
    // separate config (electron mocks, its own `include`) and a Playwright e2e suite
    // that a root glob would try to collect. Its tests run from the desktop job in
    // CI. See `apps/desktop/vitest.config.ts`.
    projects: ["apps/cli", "apps/web", "apps/worker", "packages/*"],
  },
});
