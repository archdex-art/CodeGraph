/**
 * `@codegraph/observability` — the only module allowed to write to the console
 * (HLD §14).
 *
 * Deviation from HLD §14, which names `pino`: this ships a small isomorphic
 * JSON-line implementation behind the `Logger` interface instead. Two reasons,
 * both structural rather than preference:
 *
 *  1. Six of the call sites are React client components. A Node logger cannot go
 *     into a browser bundle, and LLD §1.1 allows a package exactly ONE public
 *     entry point — so a `./client` subpath to split them is not available.
 *  2. What callers actually depend on is the `Logger` interface. pino can be
 *     dropped in behind it in P2, when the worker process gives server-side
 *     logging its own boundary and there is real log volume to justify the
 *     dependency, without touching a single call site.
 *
 * The interface is the contract; the transport is not.
 */
export type { LogFields, Logger, LogLevel, SerializedError } from "./logger";
export { createLogger, serializeError } from "./logger";

import { createLogger } from "./logger";

/**
 * The process-wide logger.
 *
 * A frozen `const`, not mutable state: `child()` returns a new logger rather
 * than reconfiguring this one, so there is nothing here for one request to
 * change out from under another (the hazard behind review item B4).
 */
export const logger = createLogger();
