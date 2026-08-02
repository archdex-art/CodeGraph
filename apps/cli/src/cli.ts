import { main } from "./main";

/**
 * Thin shim. `main()` returns an exit code rather than calling `process.exit`, so it is
 * testable without spawning — the exit code IS part of the contract (a pre-commit hook reads
 * it), and a function that kills the process cannot be asserted on.
 */
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
