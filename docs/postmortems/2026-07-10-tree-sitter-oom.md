# Postmortem: OOM-killed on any repo with real content

**Date:** 2026-07-10 · **Severity:** Critical (indexing any non-trivial repo crashed the server) · **Fixed in:** `4f78fd5`

## Summary
With the crash-loop and hang fixed, indexing still failed for any repo with meaningful source content — completely ordinary repos like `expressjs/express` and `sindresorhus/type-fest` reliably killed the container via an OOM (out-of-memory) kernel kill. Only trivially small repos (e.g. one with no real code files) succeeded.

## Impact
- Indexing any repo of realistic size crashed the entire server process (SIGKILL — not catchable by any application-level error handling).
- The crash was silent: no error surfaced anywhere, since the kernel kills the process before it can log or respond.
- Any other in-flight requests / jobs died with it.

## Root Cause
`web-tree-sitter`'s WASM linear memory is a singleton for the process lifetime, shared by every `Parser` instance, and — per the WebAssembly spec — can only **grow**, never shrink, regardless of calling `.delete()` on every `Tree`/`TreeCursor` (which this fix also added, and which is necessary but not sufficient on its own).

Measured directly by instrumenting the actual running server with memory checkpoints (not a synthetic reproduction): RSS climbed roughly 26MB per parsed file — 89MB → 234MB → 312MB → 484MB across just the first 5/10/15 of `express`'s 141 files. That inflated floor never recedes for the rest of the process's life, so everything `indexRepo()` does afterward (dependency graph, viz, tree, module graph, JSON serialization for the DB write) has to fit in whatever headroom remains under the container's 512MB limit. Two successively lower "safety ceilings" (300MB, then 150MB) were tried and both still let the container OOM once that other work ran on top — in one run, the job even reported `"done"` moments before the container died from residual growth.

## Detection
User report + direct verification: manually reproduced with Docker under Render's exact resource limits (`--memory=512m --memory-swap=512m --cpus=0.5`) against `expressjs/express`, confirmed `OOMKilled: true, exitCode: 137` via `docker inspect`.

## Resolution
Gated tree-sitter usage on **live measured RSS** (`process.memoryUsage().rss`) rather than a fixed file-count guess, checked before every parse call. Once RSS crosses a configurable ceiling (`CG_TREE_SITTER_MAX_RSS_BYTES`), tree-sitter is permanently disabled for the rest of the process's life and every subsequent file uses the already-implemented, already-correct regex fallback extractor. Default ceiling is effectively zero (disabled) — proven to run every test repo cleanly end-to-end at ~50–90MB total — since even a handful of tree-sitter-parsed files was shown to be unpredictably dangerous at 512MB. Deployments with real memory headroom (a bigger plan, self-hosted) can opt back into real AST parsing via the env var.

Verified against the exact 512MB/0.5CPU constraint: `octocat/Hello-World`, `expressjs/express` (crashed twice earlier in this incident), and `sindresorhus/type-fest` (a repo whose whole purpose is pathologically complex types) all index in 1–3s each, run sequentially in the same container, with the server staying healthy throughout.

## Prevention / Action Items
- [x] CI's Docker smoke-test job runs under the identical 512MB/0.5CPU constraint on every push, so a memory regression here fails CI immediately rather than reaching production.
- [ ] Consider expanding the CI smoke test to include a larger/more complex repo (not just `octocat/Hello-World`) so a future regression that only manifests on real content — exactly this incident's shape — is caught even earlier.
