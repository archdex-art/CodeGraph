/**
 * `eslint-plugin-security` ships no type declarations (it is plain CommonJS with
 * no bundled `.d.ts` and no `@types/` package).
 *
 * `apps/web` never saw this error because its import resolved under the same
 * `skipLibCheck` but was reached from a `.tsx`-inclusive program where the
 * implicit-any surfaced elsewhere; here it is a hard error, and suppressing it
 * with `@ts-expect-error` or a bare `any` would discard the one thing actually
 * known about the value.
 *
 * What IS known: `eslintSecurity.ts` treats the default export as opaque and hands
 * it straight to ESLint as `plugins: { security }`. That position has a real type —
 * ESLint's own `Linter.Plugin` — so declaring it as that states the contract
 * precisely rather than defeating the checker. If a future caller reaches into the
 * plugin's internals, this declaration will correctly stop compiling instead of
 * silently permitting it.
 */
declare module "eslint-plugin-security" {
  import type { ESLint } from "eslint";
  const plugin: ESLint.Plugin;
  export default plugin;
}
