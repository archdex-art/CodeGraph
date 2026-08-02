#!/usr/bin/env node
/**
 * `codegraph` entry point.
 *
 * WHAT WAS HERE BEFORE: nothing. `apps/web/package.json` declared
 * `"bin": { "codegraph": "terminal/bin.mjs" }` pointing at a file that DID NOT EXIST, so
 * `npm link` or a global install produced a command that failed on every invocation. A bin
 * entry is a claim; this is the file that makes it true.
 *
 * Runs the TypeScript sources through `tsx` rather than a build step, matching how
 * `apps/worker` runs in development. The worker gained a real esbuild bundle when it had to run
 * in a container without dev dependencies (`tsx` is absent from the standalone runtime); the CLI
 * has no such constraint yet, and adding a build before anyone installs this would be
 * scaffolding for a distribution that does not exist.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
process.argv.splice(1, 1, path.join(here, "src/cli.ts"));

const { register } = await import("tsx/esm/api");
register();
await import(pathToFileURL(path.join(here, "src/cli.ts")).href);
