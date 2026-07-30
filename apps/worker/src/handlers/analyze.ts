import path from "node:path";
import { indexRepo } from "@codegraph/analysis";
import { initTreeSitter } from "@codegraph/core-graph";
import {
  completeRepoIndex,
  dataDir,
  setRepoError,
  setRepoStatus,
} from "@codegraph/persistence";
import { cloneRepo, getHeadHash, isGithubHost, resolveLocalDir, withToken } from "@codegraph/vcs";

/**
 * The analyse pipeline, lifted from `apps/web/src/lib/store.ts`'s `runJob`
 * (LLD §13's `lib/store.ts` row: "`runJob` becomes a worker handler").
 *
 * Behaviour is unchanged. The differences are all about *where* it runs:
 *
 *  - progress is reported through the injected `report` callback rather than by
 *    writing the jobs table directly, because the supervisor owns the lease and is
 *    the only process that may write job state;
 *  - it takes an `AbortSignal` and checks it at each stage boundary. Those are the
 *    only honest checkpoints — `indexRepo` is a single synchronous-ish call and
 *    there is no way to interrupt a parse mid-file, so a cancellation arriving
 *    during indexing takes effect when that stage ends. The supervisor's SIGTERM →
 *    SIGKILL escalation is what actually bounds cancellation latency;
 *  - it no longer swallows failures into a job row. Throwing is the contract: the
 *    supervisor maps a non-zero exit to the queue's retry policy, which is the one
 *    place that knows the attempt budget.
 */

export interface AnalyzePayload {
  readonly repoId: string;
  readonly source: string;
  readonly sourceType: "git" | "local";
  /** Session-scoped, never persisted. Only ever sent to github.com — see below. */
  readonly githubToken?: string;
}

/** Not exported: the executor passes a lambda, so the name has one use, here. */
type Report = (percent: number, stage: string, message: string) => void;

export function parseAnalyzePayload(value: unknown): AnalyzePayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("analyze payload must be an object");
  }
  const p = value as Record<string, unknown>;
  const repoId = p["repoId"];
  const source = p["source"];
  const sourceType = p["sourceType"];
  if (typeof repoId !== "string" || repoId === "") throw new Error("payload.repoId is required");
  if (typeof source !== "string" || source === "") throw new Error("payload.source is required");
  if (sourceType !== "git" && sourceType !== "local") {
    throw new Error(`payload.sourceType must be "git" or "local", got ${String(sourceType)}`);
  }
  const token = p["githubToken"];
  return {
    repoId,
    source,
    sourceType,
    ...(typeof token === "string" && token !== "" ? { githubToken: token } : {}),
  };
}

/** Throws if cancellation was requested. Called only at stage boundaries. */
function checkpoint(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}

export async function analyze(
  payload: AnalyzePayload,
  report: Report,
  signal: AbortSignal
): Promise<void> {
  const { repoId, source, sourceType, githubToken } = payload;

  try {
    let root: string;
    if (sourceType === "git") {
      report(15, "cloning", "Cloning repository…");
      setRepoStatus(repoId, "cloning");
      // Clone straight into the persistent data dir (not os.tmpdir()) so the
      // editor's workspace survives process restarts / container redeploys.
      const workspaceDir = path.join(dataDir(), "workspaces", repoId);
      // Only ever hand the signed-in user's token to github.com itself — never to
      // whatever host is in `source`, so a signed-in session cannot be tricked into
      // leaking its GitHub token to a third-party remote.
      const cloneUrl = githubToken && isGithubHost(source) ? withToken(source, githubToken) : source;
      root = await cloneRepo(cloneUrl, workspaceDir);
    } else {
      report(15, "cloning", "Reading local folder…");
      setRepoStatus(repoId, "cloning");
      root = resolveLocalDir(source);
    }
    checkpoint(signal);

    report(30, "indexing", "Initializing Tree-sitter parsers…");
    await initTreeSitter();
    checkpoint(signal);

    report(55, "indexing", "Building knowledge graph…");
    setRepoStatus(repoId, "indexing");
    const result = await indexRepo(root);
    checkpoint(signal);

    report(85, "scoring", "Computing Health Score…");
    setRepoStatus(repoId, "scoring");

    // Only git sources have a meaningful commit hash (a local-folder source is not
    // even guaranteed to be a git repo). Recording it lets the Timeline engine reuse
    // this exact result for its HEAD entry instead of re-deriving it via git-archive
    // plus a second full index pass.
    const headHash = sourceType === "git" ? await getHeadHash(root) : null;

    completeRepoIndex(repoId, {
      score: result.score,
      loc: result.loc,
      languages: JSON.stringify(result.languages),
      graph: JSON.stringify(result.graphStats),
      dimensions: JSON.stringify(result.dimensions),
      issues: JSON.stringify(result.issues),
      deps: JSON.stringify(result.dependencies),
      churnByFile: JSON.stringify(result.churnByFile),
      viz: JSON.stringify(result.viz),
      tree: JSON.stringify(result.tree),
      modules: JSON.stringify(result.modules),
      symbols: JSON.stringify(result.symbolGraph),
      workspaceDir: root,
      headHash,
      finishedAt: Date.now(),
    });
    report(100, "done", `Done — Health Score ${result.score}/100`);
  } catch (e) {
    // The REPO's status is this handler's to own — it is the thing being analysed,
    // and a failed run must not leave it reading "indexing" forever. The JOB's
    // status is not: rethrowing hands that to the supervisor, which holds the lease
    // and the attempt budget.
    const message = e instanceof Error ? e.message : String(e);
    setRepoError(repoId, "error", message);
    throw e;
  }
}
