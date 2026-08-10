import { randomUUID } from "node:crypto";
import path from "node:path";
import { indexRepo } from "@codegraph/analysis";
import { coalescePhases } from "@codegraph/analysis-model";
import { initTreeSitter } from "@codegraph/core-graph";
import { createIndexCacheStore } from "@codegraph/fsx";
import { logger } from "@codegraph/observability";
import {
  completeRepoIndex,
  incrementCounter,
  recordRun,
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
  /**
   * RE-INDEX of a repo that already has a materialised workspace: skip the clone.
   *
   * Not an optimisation. The workspace is the tree the built-in editor and the git route
   * have been mutating, so cloning over it would discard uncommitted work — and the repo
   * row already points at that directory, so a re-clone elsewhere would strand it.
   */
  readonly workspaceReady?: boolean;
}

/**
 * Not exported: the executor passes a lambda, so the name has one use, here.
 *
 * The 4th argument is the live phase, already JSON. It rides the same protocol line as
 * the coarse report, so a phase tick has to restate the percent/stage/message it is
 * arriving under — see `phaseReport` below.
 */
type Report = (percent: number, stage: string, message: string, phase?: string | null) => void;

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
  const workspaceReady = p["workspaceReady"];
  return {
    repoId,
    source,
    sourceType,
    ...(typeof token === "string" && token !== "" ? { githubToken: token } : {}),
    // Absent or non-boolean means "first index", which is the safe reading: an unexpected
    // payload gets the clone it would have got before this flag existed.
    ...(workspaceReady === true ? { workspaceReady: true } : {}),
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
  const { repoId, source, sourceType, githubToken, workspaceReady } = payload;
  const startedAt = Date.now();

  try {
    let root: string;
    // Derived, never passed in: `<dataDir>/workspaces/<repoId>` is where the first clone
    // put the tree and what the repo row records, so a re-index and a first index cannot
    // end up looking at two different directories for one repo.
    const gitWorkspaceDir = path.join(dataDir(), "workspaces", repoId);
    if (workspaceReady) {
      // A RE-INDEX. The tree is already on disk and the editor may hold uncommitted work
      // in it, so cloning here would destroy exactly what we were asked to index.
      report(15, "cloning", "Reusing existing workspace…");
      setRepoStatus(repoId, "cloning");
      root = sourceType === "git" ? gitWorkspaceDir : resolveLocalDir(source);
    } else if (sourceType === "git") {
      report(15, "cloning", "Cloning repository…");
      setRepoStatus(repoId, "cloning");
      // Clone straight into the persistent data dir (not os.tmpdir()) so the
      // editor's workspace survives process restarts / container redeploys.
      // Only ever hand the signed-in user's token to github.com itself — never to
      // whatever host is in `source`, so a signed-in session cannot be tricked into
      // leaking its GitHub token to a third-party remote.
      const cloneUrl = githubToken && isGithubHost(source) ? withToken(source, githubToken) : source;
      root = await cloneRepo(cloneUrl, gitWorkspaceDir);
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
    // The signal goes INTO the pipeline, not just around it: without this a cancel
    // during indexing waits for every remaining file, and on a large repo that is the
    // whole run. indexRepo checks it at its existing per-15-file yield points.
    //
    // The cache slot is keyed by the ROOT rather than the repo id: what makes an entry
    // valid is the CONTENT HASH of each file (never its mtime or size — a same-second
    // rewrite preserves both), so a workspace re-cloned to a new path gets a fresh slot
    // instead of a stale hit, and this process and the web process — which computes the
    // same path — share one slot for one tree. A missing, corrupt or unwritable slot
    // degrades to a full index and never to a failed run: neither store method throws.
    const result = await indexRepo(root, {
      signal,
      cache: createIndexCacheStore(path.join(dataDir(), "index-cache"), root),
      // The live phase line. Coalesced by the pipeline's own helper (≤2 writes/second,
      // stage changes exempt) so the supervisor is not handed a stdout line per file,
      // and it restates the coarse report it arrives under because the protocol carries
      // one message shape — a phase with a blank stage would blank the row's `stage`
      // column and flip the UI's status vocabulary mid-index.
      onPhase: coalescePhases((phase) =>
        report(55, "indexing", "Building knowledge graph…", JSON.stringify(phase)),
      ),
    });
    // Reuse is invisible in the output by construction — an incremental run and a full run
    // of the same tree produce the same result — so the only way to notice that the cache
    // has stopped working is to say what it did.
    logger.info("index complete", {
      repoId,
      mode: result.incremental?.mode,
      reason: result.incremental?.reason,
      reused: result.incremental?.filesReused,
      changed: result.incremental?.filesChanged,
      cacheWritten: result.incremental?.cacheWritten,
    });
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
      // Mirrors the web path in `store.ts`. NULL means "this run produced no report", which
      // readers render as not-analysed; an empty object here would claim we looked.
      ownership: result.ownership ? JSON.stringify(result.ownership) : null,
      apiSurface: result.apiSurface ? JSON.stringify(result.apiSurface) : null,
      taint: result.taint ? JSON.stringify(result.taint) : null,
      unusedDeps: result.unusedDependencies ? JSON.stringify(result.unusedDependencies) : null,
      advisories: result.advisories ? JSON.stringify(result.advisories) : null,
      packageNames: result.packageNames ? JSON.stringify(result.packageNames) : null,
      workspaceDir: root,
      headHash,
      finishedAt: Date.now(),
    });

    // Record the run and its findings as ROWS, alongside the JSON blob above.
    //
    // Not decoration: migration 002 created these tables and 003 backfilled them, after
    // which nothing ever wrote to them — so `latestRunId()` returned null for every
    // repository indexed since, and anything built on the rows (`newFindingsSince`, the
    // fingerprint column P6's baseline mode keys on, review C1's per-finding `/fix`) was
    // reading data that stopped at the migration. Measured before this line existed: 4
    // issues in the blob, 0 rows in `findings`.
    /**
     * `cg_stage_duration_seconds` (HLD §14), emitted here rather than inside `indexRepo`
     * because `analysis` sits below `persistence` in the layering. The pipeline returns its
     * timings; the process that already owns the run row records them.
     *
     * Seconds, not milliseconds: the metric name says `_seconds` and Prometheus convention is
     * base units. Emitted as `_sum`/`_count` so `rate(sum)/rate(count)` gives the mean per
     * stage — enough to answer "which stage got slower", which is the question the run record
     * was promised for.
     */
    for (const [stage, ms] of Object.entries(result.stageTimings ?? {})) {
      incrementCounter("cg_stage_duration_seconds_sum", { stage }, ms / 1000);
      incrementCounter("cg_stage_duration_seconds_count", { stage });
    }

    recordRun(
      {
        id: randomUUID(),
        repoId,
        commitSha: headHash,
        score: result.score,
        loc: result.loc,
        // ADR-008. Both write paths pass it so the two cannot diverge — the reason the
        // findings rows were backfill-only was one path writing and the other not.
        coverage: result.coverage,
        startedAt: startedAt,
        finishedAt: Date.now(),
      },
      result.issues
    );

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
