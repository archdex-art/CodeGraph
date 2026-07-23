// Every CPU-bound per-file loop in the indexer yields back to the event loop
// every YIELD_EVERY files. Without this, indexRepo() runs as one long
// synchronous call — on a large repo (thousands of files, TS type-checking,
// ESLint AST parsing per file) that can block the whole Node process for tens
// of seconds, during which NOTHING else can be served: not the dashboard, not
// other API routes, not even Render's health check -- which is exactly what
// produces the "stuck on an old page, then 502 Bad Gateway" symptom on a
// large first-time index. Yielding periodically lets the event loop drain
// other pending requests between chunks of indexing work.
export const YIELD_EVERY = 15;

export function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}
