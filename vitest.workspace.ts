/**
 * Vitest workspace root (LLD §1).
 *
 * Each project keeps its own `vitest.config.ts` so a package's tests are
 * runnable in isolation (`npm test -w @codegraph/core-domain`) as well as from
 * the root — HLD §3 "Testability" requires every unit be runnable on its own,
 * and a single root config with a merged `include` would quietly break that.
 */
export default ["apps/web", "packages/*"];
