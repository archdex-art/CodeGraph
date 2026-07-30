/**
 * The executor's exit-code contract.
 *
 * Its own module so the executor does not import the SPAWNER to learn them. That
 * import also broke the compiled build: `supervise.ts` resolves the executor path via
 * `fileURLToPath(import.meta.url)`, which is undefined under CJS output, so bundling
 * the executor dragged in a path computation it never uses and then crashed on it.
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANCELLED = 2;
/** Retrying cannot help: the same bytes deserialise the same way. Quarantined. */
export const EXIT_BAD_PAYLOAD = 3;
