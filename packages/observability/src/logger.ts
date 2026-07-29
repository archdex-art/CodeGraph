/**
 * Structured logging (HLD §14).
 *
 * One JSON object per line, with `runId`/`jobId`/`stage` carried on every line
 * once a caller binds them. That shape is the point: HLD G7 requires a failure
 * to be attributable to a stage, and free-text `console.warn` lines cannot be
 * grouped, filtered, or correlated after the fact.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Arbitrary structured context. Values must be JSON-serialisable. */
export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * A logger that adds `bindings` to every line it writes.
   *
   * This is how `runId`/`jobId`/`stage` get onto every line without threading
   * them through every call: a stage takes a bound logger and just logs.
   */
  child(bindings: LogFields): Logger;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
  /** Present when the error carried a `cause`. */
  readonly cause?: SerializedError | string;
}

/**
 * Turn an unknown thrown value into something JSON can represent.
 *
 * `JSON.stringify(new Error("x"))` is `{}` — message and stack are
 * non-enumerable — so logging an error without this silently records nothing.
 * That is the failure mode this exists to prevent.
 *
 * NOTE ON REDACTION: this does not scrub credentials, deliberately. Call sites
 * that can produce a token-bearing string already pass it through
 * `redactCredentials` before logging (see lib/gitops, lib/agents/executor), and
 * that contract is carried forward verbatim per LLD §10.2. Re-scrubbing here
 * would create a second, weaker implementation of the same rule and invite
 * callers to stop doing it properly.
 */
export function serializeError(value: unknown, depth = 0): SerializedError | string {
  if (!(value instanceof Error)) {
    return typeof value === "string" ? value : String(value);
  }
  const base: SerializedError = {
    name: value.name,
    message: value.message,
    stack: value.stack,
  };
  // Bounded, because `cause` chains can be cyclic.
  if (value.cause !== undefined && depth < 3) {
    return { ...base, cause: serializeError(value.cause, depth + 1) };
  }
  return base;
}

/** Replaces Error values anywhere in `fields` so they survive serialisation. */
function normalizeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

/**
 * True when running under Node rather than in a browser.
 *
 * Guarded via `typeof` so bundlers can statically drop the Node branch from a
 * client bundle instead of trying to polyfill `process.stderr`.
 */
const IS_NODE =
  typeof process !== "undefined" &&
  typeof process.versions === "object" &&
  process.versions !== null &&
  typeof process.versions.node === "string";

/**
 * Every level goes to stderr, matching where `console.warn`/`console.error`
 * already wrote.
 *
 * Keeping the destination unchanged matters more than it looks: a self-hosted
 * operator's log scraping, and the `docker logs` output the postmortems were
 * diagnosed from, both depend on it. `info`/`debug` also go to stderr rather
 * than stdout so that a future CLI can keep stdout clean for machine-readable
 * output.
 */
function write(line: string): void {
  if (IS_NODE) {
    process.stderr.write(`${line}\n`);
    return;
  }
  // Browser: this is the one module allowed to touch console (HLD §14), and a
  // React component's diagnostics have nowhere else to go.
  // eslint-disable-next-line no-console
  console.error(line);
}

interface LoggerOptions {
  readonly bindings?: LogFields;
  /** Injectable for tests; defaults to the real sink. */
  readonly sink?: (line: string) => void;
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Create a logger.
 *
 * No level filtering, on purpose. v1's `console.warn`/`console.error` calls
 * always printed, and silencing any of them by default would be a behaviour
 * change that hides diagnostics an operator currently sees. A `CG_LOG_LEVEL`
 * filter belongs with the worker in P2, where there is enough log volume for it
 * to earn its keep.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? write;
  const now = options.now ?? Date.now;

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    const payload: Record<string, unknown> = {
      // Field order is deliberate: level and time first so a human scanning raw
      // lines gets the two things they always want without reading past the
      // payload.
      level,
      time: new Date(now()).toISOString(),
      msg: message,
      ...normalizeFields(bindings),
      ...(fields ? normalizeFields(fields) : {}),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      // A circular or otherwise unserialisable field must not turn a log line
      // into an outage. Fall back to the one thing guaranteed to serialise.
      sink(JSON.stringify({ level, time: new Date(now()).toISOString(), msg: message, logError: "unserializable fields" }));
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childBindings) =>
      createLogger({
        ...options,
        bindings: { ...bindings, ...childBindings },
      }),
  };
}
