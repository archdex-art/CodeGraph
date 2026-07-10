# Postmortem: Indexing hung forever at "Initializing Tree-sitter parsers…"

**Date:** 2026-07-10 · **Severity:** Critical (indexing never completed) · **Fixed in:** `25cd6ec`

## Summary
After fixing the disk-permission crash (see prior postmortem), indexing jobs progressed past cloning but then hung indefinitely at 30% progress, message "Initializing Tree-sitter parsers…". No timeout, no error, no completion — the job simply never moved again.

## Impact
- 100% of indexing requests hung forever once they reached the tree-sitter init step.
- The server process itself stayed up and kept answering `/api/health` and other requests — only the specific stuck job (and any job serialized behind it, given the single-process fire-and-forget job model) was affected.

## Root Cause
`web-tree-sitter`'s Emscripten-generated WASM loader can leave its `Parser.init()` promise **permanently unresolved** — neither resolved nor rejected — when the underlying WASM binary fails to load. Internally, a failed load path calls the module's `abort()`, which `throw`s a `WebAssembly.RuntimeError` from deep inside the loader's own promise chain. That throw never reaches the `Promise` object the application code is `await`ing; it surfaces instead as a Node-level `unhandledRejection`, which Next.js's own global handler catches and logs, keeping the *server process* alive — but the specific `await initTreeSitter()` call in `runJob()` has no way of ever being told the attempt failed. `initTreeSitter()`'s `try/catch` (which was supposed to fall back to the regex extractor on any WASM failure) never fires, because nothing ever throws *into* it.

Reproduced directly: deleting `wasm/` inside a running container and triggering an index left the job frozen at the same message indefinitely (15+ polls, no change) — bit for bit the symptom reported live.

## Detection
User report — the job status API kept returning the same frozen state, and no error surfaced anywhere in logs (Next's `unhandledRejection` log line is easy to miss and doesn't correlate to a specific job by default).

## Resolution
`initTreeSitter()` now races `Parser.init()` / `Parser.Language.load()` against a hard timeout (`CG_TREE_SITTER_INIT_TIMEOUT_MS`, default 20s) via `Promise.race`. Whichever failure mode caused the original hang, the timeout guarantees the `await` always eventually settles, and the existing `catch` block's regex fallback (already implemented, just unreachable) takes over.

## Prevention / Action Items
- [x] CI's Docker smoke-test job indexes a real repo end-to-end on every push — a regression here would fail that step within its poll loop's timeout, not silently pass.
- [ ] Consider adding an explicit `unhandledRejection` handler that logs with enough context (job ID) to correlate a stray rejection like this one back to the request that triggered it, rather than relying on generic framework-level logging.
