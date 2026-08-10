import { buildSchema, loadConfig, type Config } from "./definition";
import { liveView } from "./schema";

export type { Config, LoadOptions, Schema } from "./definition";
export { buildSchema, loadConfig } from "./definition";
export { ConfigError } from "./schema";
export type { EnvSource, Problem, Reader } from "./schema";

/**
 * Validate the real environment now, at import time.
 *
 * This is what makes "fail fast at boot" true rather than aspirational: an
 * invalid variable throws during module initialisation with every problem listed
 * at once, instead of surfacing on whichever request first happens to read it.
 * The returned snapshot is deliberately discarded — `config` below reads live.
 */
loadConfig(process.env);

/**
 * The process's configuration.
 *
 * Reads `process.env` at each property access rather than snapshotting, which
 * preserves v1's semantics exactly: every v1 call site read `process.env` on
 * every call, so a value changed after boot took effect immediately. Seven test
 * files depend on that, including the security regression tests for the `Secure`
 * cookie flag and for spoof-resistant rate-limit keying, and a snapshot silently
 * broke 48 of them. It also avoids a subtler trap — ES imports are hoisted, so a
 * test's top-level `process.env.CG_DATA_DIR = tmp` runs *after* the modules it
 * imported were evaluated, and a config frozen during that evaluation would
 * point every test at the developer's real database.
 *
 * The object is frozen and holds no state of its own, so this is not the
 * module-level mutable state behind review item B4 — the state is the process
 * environment, which belongs to the platform.
 *
 * Server-side only. Nothing in the browser should import this (verified: the one
 * `NEXT_PUBLIC_*` read in the codebase is server-side, in lib/githubOAuth.ts).
 */
export const config: Config = liveView(buildSchema(), () => process.env);

/**
 * Environment for a spawned child process: the parent's environment plus
 * explicit overrides.
 *
 * This exists so "no `process.env` outside config" can be enforced without lying
 * about what the code needs. A handful of call sites legitimately require the
 * *whole* inherited environment rather than any particular value — `git` needs
 * PATH, HOME, SSH_AUTH_SOCK and the rest to run at all, and a sandboxed build
 * toolchain needs whatever its own launcher put there. That is environment
 * *propagation*, not a configuration read, and no typed schema can stand in for
 * it.
 *
 * Keeping them here makes the ban a real invariant with one explicit, greppable
 * exception rather than a rule with three scattered violations.
 */
export function childEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): typeof process.env {
  // `typeof process.env` rather than `Record<string, string | undefined>`,
  // because Next's next-env.d.ts augments NodeJS.ProcessEnv to make NODE_ENV
  // *required*. A plain Record is therefore not assignable to the `env` option
  // of child_process.execFile inside apps/web, which is the only place this is
  // used. Deriving the type from `process.env` keeps it correct in whichever
  // compilation is doing the checking.
  //
  // Object.assign rather than object spread: its result type is an intersection
  // that still includes ProcessEnv, so it satisfies the required-NODE_ENV
  // augmentation without needing a cast to paper over it.
  return Object.assign({}, process.env, overrides);
}
