import { logger } from "@codegraph/observability";
import { runWorker } from "./main";

// Separate from main.ts so tests can import `runWorker` without starting a poll loop.
// The alternative — an `import.meta.url === argv[1]` guard — is four lines of path
// normalisation that breaks differently under tsx, npm, and a debugger.
runWorker().catch((e: unknown) => {
  logger.error("worker crashed", { err: e instanceof Error ? e : String(e) });
  process.exit(1);
});
