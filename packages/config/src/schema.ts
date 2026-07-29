/**
 * A very small declarative reader for environment variables (LLD §10.3).
 *
 * Deliberately hand-rolled rather than reaching for a validation library. The
 * job is about thirty lines of parsing plus one rule — *collect* problems, never
 * throw on the first — and the surrounding types are the actual product here.
 * A schema library would bring a dependency into the lowest layer of the stack
 * to save very little, and its aggregated error output would need reshaping into
 * an operator-readable list anyway.
 */

/** Just enough of `process.env` to be substitutable in a test. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface Problem {
  readonly key: string;
  readonly value: string;
  readonly expected: string;
}

/**
 * Thrown at import time when the environment is unusable.
 *
 * Reports EVERY invalid variable at once. Fixing a misconfigured deployment one
 * boot at a time is the failure mode this exists to prevent: v1 read
 * `process.env` in nine modules with inline fallbacks, so a typo in
 * `CG_MAX_FILES` silently became the default and the effective configuration
 * could not be known without grepping.
 */
export class ConfigError extends Error {
  constructor(readonly problems: readonly Problem[]) {
    const lines = problems.map((p) => `  ${p.key}=${JSON.stringify(p.value)} — expected ${p.expected}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
  }
}

/** A single variable's parser. `read` appends to `problems` instead of throwing. */
export interface Reader<T> {
  readonly keys: readonly string[];
  read(source: EnvSource, problems: Problem[]): T;
}

/** Present-and-non-empty, else `undefined`. Whitespace-only counts as absent. */
function present(source: EnvSource, key: string): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  return raw.trim() === "" ? undefined : raw;
}

export function stringVar(key: string, fallback: string): Reader<string> {
  return {
    keys: [key],
    read: (source) => present(source, key) ?? fallback,
  };
}

export function optionalStringVar(key: string): Reader<string | undefined> {
  return {
    keys: [key],
    read: (source) => present(source, key),
  };
}

/** A default computed from the environment itself (e.g. from `NODE_ENV`). */
export function derivedStringVar(key: string, fallback: (source: EnvSource) => string): Reader<string> {
  return {
    keys: [key],
    read: (source) => present(source, key) ?? fallback(source),
  };
}

export interface IntOptions {
  readonly fallback: number;
  readonly min?: number;
  readonly max?: number;
}

export function intVar(key: string, options: IntOptions): Reader<number> {
  const { fallback, min, max } = options;
  const bounds = [
    "an integer",
    min !== undefined ? `>= ${min}` : null,
    max !== undefined ? `<= ${max}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return {
    keys: [key],
    read: (source, problems) => {
      const raw = present(source, key);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      // Number("") is 0 and Number(" 1 ") is 1, so guard explicitly rather than
      // trusting the coercion. v1 used `Number(x) || default`, which silently
      // swallowed both garbage AND a deliberate 0.
      if (!Number.isInteger(parsed)) {
        problems.push({ key, value: raw, expected: bounds });
        return fallback;
      }
      if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
        problems.push({ key, value: raw, expected: bounds });
        return fallback;
      }
      return parsed;
    },
  };
}

function parseBool(
  source: EnvSource,
  key: string,
  problems: Problem[],
): boolean | undefined {
  const raw = present(source, key);
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  problems.push({ key, value: raw, expected: '"true" or "false"' });
  return undefined;
}

/**
 * Boolean with a default that may itself depend on the environment.
 *
 * The derived default is not decoration: `CG_ALLOW_LOCAL_ACCESS` unset means
 * `NODE_ENV !== "production"`, not `false`, so collapsing it to a fixed default
 * changes what the app does when the variable is absent.
 */
export function boolVar(key: string, fallback: (source: EnvSource) => boolean): Reader<boolean> {
  return {
    keys: [key],
    read: (source, problems) => parseBool(source, key, problems) ?? fallback(source),
  };
}

/**
 * Boolean that stays genuinely three-valued: `true`, `false`, or `undefined`
 * for "not configured".
 *
 * Required where "unset" selects a different *mechanism* rather than a different
 * value. `CG_FORCE_SECURE_COOKIES` is the case that forced this to exist: when
 * it is unset, lib/session.ts does not fall back to a constant, it inspects the
 * actual transport (`x-forwarded-proto`, then the request scheme). Resolving it
 * eagerly to `NODE_ENV === "production"` would mark cookies `Secure` on a
 * production deployment served over plain HTTP behind a proxy, so the browser
 * would stop sending the session cookie and sign-in would break.
 */
export function optionalBoolVar(key: string): Reader<boolean | undefined> {
  return {
    keys: [key],
    read: (source, problems) => parseBool(source, key, problems),
  };
}

/** Only whether the variable is set at all, per the NO_COLOR convention. */
export function presenceVar(key: string): Reader<boolean> {
  return {
    keys: [key],
    read: (source) => source[key] !== undefined,
  };
}

/**
 * A value derived from the environment rather than read from a single key.
 *
 * Keeps things like `isProduction` inside the resolved config object — so every
 * consumer still gets it from one place — without pretending it maps to a
 * variable an operator can set.
 */
export function computed<T>(compute: (source: EnvSource) => T): Reader<T> {
  return { keys: [], read: (source) => compute(source) };
}

export type ReaderMap = Readonly<Record<string, Reader<unknown>>>;

export type Resolved<S extends ReaderMap> = {
  readonly [K in keyof S]: S[K] extends Reader<infer T> ? T : never;
};

/**
 * Runs every reader against `source` and throws once if anything was invalid.
 *
 * Used for two things: producing a snapshot in tests, and validating the real
 * environment at boot so a misconfiguration is reported all at once rather than
 * on whichever request first happens to read it.
 */
export function resolve<S extends ReaderMap>(schema: S, source: EnvSource): Resolved<S> {
  const problems: Problem[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, reader] of Object.entries(schema)) {
    out[name] = reader.read(source, problems);
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(out) as Resolved<S>;
}

/** One reader, throwing rather than accumulating. */
function resolveOne<T>(reader: Reader<T>, source: EnvSource): T {
  const problems: Problem[] = [];
  const value = reader.read(source, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return value;
}

/**
 * A frozen view over a *live* environment: every property read re-reads
 * `source()` at access time.
 *
 * This is deliberately not a snapshot, and the reason is behavioural. v1 read
 * `process.env` at every call site on every call, so a value changed after boot
 * took effect immediately — which the existing test suite depends on in seven
 * files, several of them the security regression tests for the `Secure` cookie
 * flag and for rate-limit IP keying. A snapshot also breaks a subtler thing:
 * ES module imports are hoisted, so a test's top-level
 * `process.env.CG_DATA_DIR = tmp` runs *after* the modules it imported have
 * already been evaluated, and a config frozen during that evaluation would
 * point every test at the developer's real database.
 *
 * The object itself holds no state — it is frozen and owns nothing — so this
 * does not reintroduce the module-level mutable state behind review item B4.
 * The state is the process environment, which belongs to the platform.
 */
export function liveView<S extends ReaderMap>(schema: S, source: () => EnvSource): Resolved<S> {
  const descriptors: PropertyDescriptorMap = {};
  for (const [name, reader] of Object.entries(schema)) {
    descriptors[name] = {
      enumerable: true,
      get: () => resolveOne(reader, source()),
    };
  }
  return Object.freeze(Object.defineProperties({}, descriptors)) as Resolved<S>;
}
