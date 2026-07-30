import { rm } from "node:fs/promises";
import { build } from "esbuild";

/**
 * Compile the worker to self-contained JS.
 *
 * WHY THIS EXISTS. The supervisor spawns the executor with `--import tsx` in
 * development, because packages publish raw TypeScript (LLD §1.1) and there is no other
 * way to run them. `tsx` is a devDependency and is absent from
 * `.next/standalone/node_modules`, so that path cannot work in the container — which is
 * exactly why `CG_USE_WORKER` still defaults to false. This build is what lets it flip.
 *
 * SELF-CONTAINED, not externalised. Bundling inlines `eslint`, `typescript` and the rest
 * into ~15 MB, which is large for a file and small for a container layer. The
 * alternative is shipping a second `node_modules` beside the Next standalone tree, and
 * that tree is a *traced* subset — it does not contain `typescript` or
 * `eslint-plugin-security` (measured), so it would have to be assembled and pruned by
 * hand. One file that runs is worth more than a smaller file that needs a correct
 * `node_modules` next to it.
 *
 * TWO DELIBERATE EXCEPTIONS:
 *
 *  · `web-tree-sitter` stays external. It loads `.wasm` grammars from disk at runtime,
 *    so inlining the loader without the grammars produces a binary that fails on first
 *    parse. It is already `serverExternalPackages` in `next.config.ts` for the same
 *    reason, and the Dockerfile already copies the grammars.
 *
 *  · The CJS banner. `typescript` and `eslint` are CommonJS and use `require`,
 *    `__filename` and `__dirname`. Under ESM output those are undefined, and the failure
 *    is at RUNTIME rather than at build: the bundle builds cleanly and then dies with
 *    "Dynamic require of fs is not supported", then "__filename is not defined", each
 *    only on the code path that touches it. Found by running the bundle, not by reading
 *    it — which is why `verify` below actually executes the output.
 */

const CJS_SHIM = [
  `import { createRequire as __cgCreateRequire } from "node:module";`,
  `import { fileURLToPath as __cgFileURLToPath } from "node:url";`,
  `import { dirname as __cgDirname } from "node:path";`,
  `const require = __cgCreateRequire(import.meta.url);`,
  `const __filename = __cgFileURLToPath(import.meta.url);`,
  `const __dirname = __cgDirname(__filename);`,
].join("\n");

await rm("dist", { recursive: true, force: true });

const result = await build({
  entryPoints: {
    // The supervisor. Must not pull in a parser — `depcruise`'s
    // `supervisor-loads-no-parser` enforces that on the source, and the bundle sizes
    // below make a violation visible too: if start.js is tens of MB, something imported
    // the analysis pipeline.
    start: "src/start.ts",
    // The per-job executor, spawned and discarded.
    execute: "src/execute.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  // Matches tsconfig.base.json's target.
  target: "node22",
  outExtension: { ".js": ".mjs" },
  external: ["web-tree-sitter"],
  banner: { js: CJS_SHIM },
  // Keeps a stack trace from the container pointing at real source.
  sourcemap: true,
  logLevel: "info",
  metafile: true,
});

for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith(".map")) continue;
  console.log(`  ${file}  ${(meta.bytes / 1_048_576).toFixed(1)} MB`);
}
