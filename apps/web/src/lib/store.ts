import { initTreeSitter } from "@codegraph/core-graph";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ViewerId } from "@codegraph/core-domain";
import { config } from "@codegraph/config";
import { createJobQueue } from "@codegraph/jobs";
import {
  completeRepoIndex,
  recordRun,
  dataDir,
  deleteRepo as deleteRepoRow,
  findQueuedJob,
  findRepo,
  findRepoUnscoped,
  insertJob,
  insertRepo,
  listFleetRepos as listFleetRepoRows,
  listRepos as listRepoRows,
  repoOwnerId,
  repoWorkspace,
  saveMode as readSaveMode,
  setRepoError,
  setRepoStatus,
  setSaveMode as writeSaveMode,
  updateJob,
  type RepoRow,
} from "@codegraph/persistence";
import { indexRepo } from "@codegraph/analysis";
import { cleanup, cloneRepo, getHeadHash, isGithubHost, resolveLocalDir, withToken } from "@codegraph/vcs";
import { emptyTrash } from "./trash";
import type { FleetRepo, Job, JobStatus, RepoDetail, RepoSummary, SaveMode, SourceType, VizGraph, IndexResult } from "./types";

/**
 * Built lazily rather than at module load: this module is imported by route files
 * that Next may evaluate during build, and constructing the queue opens SQLite.
 */
let queue: ReturnType<typeof createJobQueue> | null = null;
const jobQueue = (): ReturnType<typeof createJobQueue> => (queue ??= createJobQueue());

/**
 * Application-level repo/job operations.
 *
 * No SQL lives here any more — every statement moved to
 * `@codegraph/persistence`, which is the only module allowed to write it
 * (LLD §8). What remains is orchestration: the indexing job body, and the
 * mapping between database rows and the API's view types.
 *
 * `runJob` is still fire-and-forget inside the web process. Moving it to a real
 * worker is P2 (HLD §17); doing it here would change the request path's
 * behaviour, which P1 may not.
 */

const EMPTY_VIZ: VizGraph = { nodes: [], edges: [], truncated: false };
const EMPTY_TREE = { name: "/", path: ".", children: [] };
const EMPTY_MODULES = { nodes: [], edges: [] };
const EMPTY_SYMBOLS = {
  symbols: [],
  edges: [],
  truncated: false,
  stats: { symbols: 0, edges: 0, resolvedCalls: 0 },
};

function gitName(url: string): string {
  const m = url.replace(/\.git$/, "").match(/([^/]+\/[^/]+)\/?$/);
  return m ? (m[1] ?? url) : url;
}

/** JSON column → value, falling back when the column is empty or unparseable. */
function parseColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export type CreateIndexJobResult =
  | { readonly ok: true; readonly jobId: string; readonly repoId: string; readonly deduplicated: boolean }
  /**
   * The per-repo mutex refused. Not an error: submitting the same repository twice
   * (double-click, two tabs) is an ordinary thing to do, and the caller wants the
   * in-flight job's id so it can attach to that progress stream.
   */
  | { readonly ok: false; readonly reason: "repo-busy"; readonly jobId: string; readonly repoId: string };

/**
 * Enqueue an analysis run.
 *
 * P2 cutover: this used to end in `void runJob(...)` — fire-and-forget inside the web
 * process, which is what made a parse able to OOM the server (ADR-001). It now writes
 * a queued row and returns; `apps/worker` claims it and runs it in a child process
 * that dies with the job, reclaiming the WASM heap.
 *
 * IDEMPOTENCY IS NARROWER THAN HLD §418 SPECIFIES, deliberately. §418 wants
 * `hash(repoId, commitSha, engineVersion)`, so re-submitting the same commit returns
 * the existing run. That cannot be computed here: the commit is unknown until the repo
 * is cloned, which is the worker's first step. Keying on the freshly-minted `repoId`
 * would make every key unique and the column decorative — worse than honest absence,
 * because it would look implemented. The commit-aware key belongs with P6's
 * baseline/PR-scoped work, which is the phase that needs `commitSha` before enqueue
 * anyway. What IS enforced today is the per-repo mutex below, which covers the failure
 * §418 is really guarding: two concurrent runs on one workspace directory.
 */
export function createIndexJob(
  source: string,
  sourceType: SourceType,
  githubToken?: string,
  ownerId?: number | null,
): CreateIndexJobResult {
  const repoId = randomUUID();
  const jobId = randomUUID();
  const name = sourceType === "git" ? gitName(source) : path.basename(source.replace(/\/+$/, "")) || source;

  insertRepo({
    id: repoId,
    url: source,
    name,
    sourceType,
    ownerId: ownerId ?? null,
    createdAt: Date.now(),
  });

  // STRANGLER-FIG FLIP (LLD §13.1 step 4, the pattern `CG_ENGINE=v1|v2|both` uses).
  //
  // Default is the inline path, and that is not timidity — it is the only correct
  // default until the worker is DEPLOYABLE. Measured today: the container runs
  // `CMD ["node", "apps/web/server.js"]` and nothing else, and `tsx` is absent from
  // the standalone runtime, so a queued job in production would sit unclaimed
  // forever. Enqueuing by default would have turned "indexing is slow" into
  // "indexing silently never happens", which is strictly worse than the OOM it
  // replaces.
  //
  // Flip to `true` in the same commit that (a) compiles the worker to JS and (b) runs
  // it alongside the web process in the container. The 512 MB two-concurrent-job
  // smoke test is what proves that commit, and it is the real exit criterion for P2.
  if (!config.useWorker) {
    insertJob(jobId, repoId);
    void runJob(jobId, repoId, source, sourceType, githubToken);
    return { ok: true, jobId, repoId, deduplicated: false };
  }

  const queued = jobQueue().enqueue({
    id: jobId,
    repoId,
    kind: "analyze",
    payload: {
      repoId,
      source,
      sourceType,
      // Session-scoped and never persisted beyond this row. The worker only ever
      // sends it to github.com — see the handler.
      ...(githubToken ? { githubToken } : {}),
    },
  });

  if (!queued.ok) {
    return { ok: false, reason: "repo-busy", jobId: queued.activeJobId, repoId };
  }
  return { ok: true, jobId: queued.jobId, repoId, deduplicated: queued.deduplicated };
}


/**
 * The queue's status vocabulary is not the UI's, and the cast that used to sit here hid
 * that.
 *
 * `jobs.status` holds the QUEUE's states (LLD §8.1:
 * `queued|leased|running|succeeded|failed|cancelled`) while `JobStatus` is what the
 * dashboard polls (`queued|cloning|indexing|scoring|done|error`). `r.status as JobStatus`
 * compiled fine and produced `"succeeded"`, which `page.tsx:79` never matches — so with
 * `CG_USE_WORKER=true` the client polls a finished job forever. Verified in the container
 * before this mapping existed.
 *
 * `stage` is preferred over `status` for in-flight work: it is the pipeline phase the
 * executor reported and is already the UI's vocabulary, where `status` only says the job
 * is running. Falling back to `indexing` is honest — a claimed job that has not reported
 * yet has been picked up, and the UI has no state for "leased".
 */
function toJobStatus(status: string, stage: string | null): JobStatus {
  switch (status) {
    case "succeeded":
      return "done";
    case "failed":
    case "cancelled":
      return "error";
    case "queued":
      return "queued";
    case "leased":
      // Claimed, executor spawning, NOTHING reported yet. Mapped to "queued" rather than
      // "indexing" because the row's `message` still reads "Queued", and an earlier
      // version that returned "indexing" here produced a visibly incoherent frame in the
      // SSE stream: `status: "indexing"` beside `message: "Queued"`. Understating a ~100ms
      // window is better than contradicting the message next to it.
      return "queued";
    case "running":
      // The executor has checked in. Prefer the stage it reported — already the UI's
      // vocabulary — and fall back only if it reported progress without one.
      return stage === "cloning" || stage === "indexing" || stage === "scoring"
        ? stage
        : "indexing";
    default:
      // The inline path writes UI states directly, so anything else is already one.
      return status as JobStatus;
  }
}

export function getJob(jobId: string): Job | null {
  const r = findQueuedJob(jobId);
  if (!r) return null;
  return {
    id: r.id,
    repoId: r.repo_id,
    status: toJobStatus(r.status, r.stage),
    progress: r.progress,
    message: r.message,
    error: r.error,
  };
}

/** Repos visible to `viewer`: the shared public bucket plus the viewer's own. */
export function listRepos(viewer: ViewerId): RepoSummary[] {
  return listRepoRows(viewer).map((r) => ({
    id: r.id,
    url: r.url,
    name: r.name,
    sourceType: (r.source_type || "git") as SourceType,
    status: r.status as JobStatus,
    score: r.score ?? null,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? null,
  }));
}

/**
 * `deps` → package names.
 *
 * A blob that is corrupt, or that is valid JSON but not the string array the
 * indexer writes, degrades to "no known dependencies" for that one repo. The
 * fleet graph is a whole-estate view: one unparseable row must cost its own
 * edges, not the entire response.
 */
function parseDependencies(raw: string | null | undefined): string[] {
  const parsed = parseColumn<unknown>(raw, null);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((d): d is string => typeof d === "string");
}

/**
 * Finished repos visible to `viewer`, carrying their dependency names.
 *
 * The fleet graph's whole input, in one query. Deliberately not `getRepo` in a
 * loop: that parses the symbol graph and every other heavy blob per repo
 * (REVIEW B7).
 */
export function listFleetRepos(viewer: ViewerId): FleetRepo[] {
  return listFleetRepoRows(viewer).map((r) => ({
    id: r.id,
    url: r.url,
    name: r.name,
    sourceType: (r.source_type || "git") as SourceType,
    score: r.score ?? null,
    loc: r.loc ?? 0,
    dependencies: parseDependencies(r.deps),
  }));
}

/** Lean ownership lookup for authz checks. */
export function getRepoOwnerId(id: string): number | null | undefined {
  return repoOwnerId(id);
}

function toRepoDetail(r: RepoRow): RepoDetail {
  return {
    id: r.id,
    url: r.url,
    name: r.name,
    sourceType: (r.source_type || "git") as SourceType,
    status: r.status as JobStatus,
    hasWorkspace: Boolean(r.workspace_dir),
    score: r.score ?? null,
    error: r.error ?? null,
    loc: r.loc ?? 0,
    languages: parseColumn(r.languages, []),
    graphStats: parseColumn(r.graph, {} as RepoDetail["graphStats"]),
    dimensions: parseColumn(r.dimensions, []),
    issues: parseColumn(r.issues, []),
    dependencies: parseColumn(r.deps, []),
    churnByFile: parseColumn(r.churn_by_file, {}),
    viz: parseColumn(r.viz, EMPTY_VIZ),
    tree: parseColumn(r.tree, EMPTY_TREE),
    modules: parseColumn(r.modules, EMPTY_MODULES),
    symbolGraph: parseColumn(r.symbols, EMPTY_SYMBOLS),
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? null,
  };
}

/**
 * One repo, or null if it does not exist OR is not visible to `viewer`.
 *
 * The viewer is mandatory: the whole point of pushing the predicate into
 * persistence (LLD §8) is that a route cannot forget it. Callers that act as the
 * system rather than for a viewer use `getRepoForSystem`.
 */
export function getRepo(id: string, viewer: ViewerId): RepoDetail | null {
  const r = findRepo(id, viewer);
  return r ? toRepoDetail(r) : null;
}

/**
 * One repo with no visibility filter, for the background job runner and the
 * timeline engine.
 *
 * Named so that every unscoped read is greppable. Never reachable from a route
 * handler acting on a user's behalf.
 */
export function getRepoForSystem(id: string): RepoDetail | null {
  const r = findRepoUnscoped(id);
  return r ? toRepoDetail(r) : null;
}

/**
 * Delete a repo, its jobs, and its trash. Removes the on-disk workspace only
 * for git clones (a "local" workspace is the user's real folder — never
 * touched); trash blobs always live under our own data dir, so those are
 * purged regardless of source type.
 */
export function deleteRepo(id: string, viewer: ViewerId): boolean {
  // Read the location BEFORE the row goes away, but delete through the scoped
  // repository so a non-owner cannot remove anything.
  const location = repoWorkspace(id);
  const removed = deleteRepoRow(id, viewer);
  if (!removed) return false;
  if (location?.source_type === "git" && location.workspace_dir) cleanup(location.workspace_dir);
  emptyTrash(id);
  return true;
}

/**
 * The already-computed indexer result for the exact commit this repo's
 * live workspace was last indexed at (`head_hash`, git sources only).
 * Consumed by TimelineEngine.ensureSnapshot to skip a redundant
 * git-archive + full re-index pass when a requested timeline entry is
 * that same commit — the common case, since the timeline UI defaults to
 * its newest entry on open. Returns null if the repo hasn't finished
 * indexing, isn't a git source, or predates this tracking.
 *
 * Unscoped: the timeline engine runs as the system, for a repo whose access was
 * already checked by the route that started it.
 */
export function getIndexedHead(id: string): { hash: string; result: IndexResult } | null {
  const r = findRepoUnscoped(id);
  if (!r || r.status !== "done" || !r.head_hash) return null;
  return {
    hash: r.head_hash,
    result: {
      score: r.score ?? 0,
      loc: r.loc ?? 0,
      languages: parseColumn(r.languages, []),
      graphStats: parseColumn(r.graph, {} as IndexResult["graphStats"]),
      dimensions: parseColumn(r.dimensions, []),
      issues: parseColumn(r.issues, []),
      dependencies: parseColumn(r.deps, []),
      churnByFile: parseColumn(r.churn_by_file, {}),
      viz: parseColumn(r.viz, EMPTY_VIZ),
      tree: parseColumn(r.tree, EMPTY_TREE),
      modules: parseColumn(r.modules, EMPTY_MODULES),
      symbolGraph: parseColumn(r.symbols, EMPTY_SYMBOLS),
    },
  };
}

/** Resolve the on-disk workspace root for a repo, or null if not indexed yet. */
export function getWorkspaceDir(id: string): { dir: string; sourceType: SourceType } | null {
  const r = repoWorkspace(id);
  if (!r?.workspace_dir) return null;
  return { dir: r.workspace_dir, sourceType: (r.source_type as SourceType) || "git" };
}

export function getSaveMode(id: string): SaveMode {
  return (readSaveMode(id) as SaveMode) || "local";
}

export function setSaveMode(id: string, mode: SaveMode): void {
  writeSaveMode(id, mode);
}

function setJob(jobId: string, status: JobStatus, progress: number, message: string, error?: string): void {
  updateJob(jobId, status, progress, message, error);
}

async function runJob(
  jobId: string,
  repoId: string,
  source: string,
  sourceType: SourceType,
  githubToken?: string,
): Promise<void> {
  const jobStartedAt = Date.now();
  try {
    let root: string;
    if (sourceType === "git") {
      setJob(jobId, "cloning", 15, "Cloning repository…");
      setRepoStatus(repoId, "cloning");
      // Clone straight into the persistent data dir (not os.tmpdir()) so the
      // editor's workspace survives process restarts / container redeploys.
      const workspaceDir = path.join(dataDir(), "workspaces", repoId);
      // Only ever hand the signed-in user's token to github.com itself —
      // never to whatever host is in `source`, so a signed-in session can't
      // be tricked into leaking its GitHub token to a third-party remote.
      const cloneUrl = githubToken && isGithubHost(source) ? withToken(source, githubToken) : source;
      root = await cloneRepo(cloneUrl, workspaceDir);
    } else {
      setJob(jobId, "cloning", 15, "Reading local folder…");
      setRepoStatus(repoId, "cloning");
      root = resolveLocalDir(source);
    }

    setJob(jobId, "indexing", 30, "Initializing Tree-sitter parsers…");
    await initTreeSitter();

    setJob(jobId, "indexing", 55, "Building knowledge graph…");
    setRepoStatus(repoId, "indexing");
    const result = await indexRepo(root);

    setJob(jobId, "scoring", 85, "Computing Health Score…");
    setRepoStatus(repoId, "scoring");

    // Only git sources have a meaningful commit hash (a local-folder source
    // is never even guaranteed to be a git repo). Recording it lets the
    // Timeline engine reuse this exact result for its HEAD entry instead of
    // re-deriving it from scratch via git-archive + a second full index pass.
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

    // Record the run and its findings as ROWS, alongside the JSON blob above.
    //
    // Not decoration: migration 002 created these tables and 003 backfilled them, after
    // which nothing ever wrote to them — so `latestRunId()` returned null for every
    // repository indexed since, and anything built on the rows (`newFindingsSince`, the
    // fingerprint column P6's baseline mode keys on, review C1's per-finding `/fix`) was
    // reading data that stopped at the migration. Measured before this line existed: 4
    // issues in the blob, 0 rows in `findings`.
    recordRun(
      {
        id: randomUUID(),
        repoId,
        commitSha: headHash,
        score: result.score,
        loc: result.loc,
        startedAt: jobStartedAt,
        finishedAt: Date.now(),
      },
      result.issues
    );

    setJob(jobId, "done", 100, `Done — Health Score ${result.score}/100`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setJob(jobId, "error", 100, "Indexing failed", msg);
    setRepoError(repoId, "error", msg);
  }
}
