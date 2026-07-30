/**
 * `@codegraph/remediate-engine` — fix providers and the apply loop (LLD §1, §7.1).
 *
 * Created because `apps/cli` needs to run the same codemods as `apps/web`, and
 * `no-cross-app-imports` forbids it importing the web app. LLD §13's migration map routes
 * `lib/agents/fixers.ts` → `remediate-engine/providers/` and `lib/agents/executor.ts` →
 * `remediate-engine` + `apps/worker/handlers/fix.ts`; this lands the providers and the apply
 * loop, which is what both hosts share.
 *
 * DELIBERATELY NOT HERE: cloning, the PR draft, the publish step, and counter writes. Those are
 * host concerns — the CLI never opens a PR and has no database — and pulling them in would make
 * this package depend on `vcs` and `persistence` for code one of its two consumers cannot use.
 */
export { applyFixes, walkCode, type ApplyResult, type FileChange } from "./apply";
export { candidateFor, parseCheck } from "./candidate";
export { FIXERS, fixerById, fixersForRule, legacyRuleIdFor } from "./providers/fixers";
export { deletableDebugLines, isJsLike, type DeletableLines } from "./providers/ast-guards";
export type { FileEdit, FixScope, Fixer, FixerInput, FixerOutput } from "./types";
