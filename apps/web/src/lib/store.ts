import { initTreeSitter } from "@codegraph/core-graph";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ViewerId } from "@codegraph/core-domain";
import { config } from "@codegraph/config";
import { createJobQueue, createSlotGate, type SlotGate } from "@codegraph/jobs";
import {
  abandonOrphanedJobs,
  completeRepoIndex,
  latestRunCoverage,
  recordRun,
  dataDir,
  deleteRepo as deleteRepoRow,
  findQueuedJob,
  findRepo,
  findRepoUnscoped,
  findLiveJobForRepo,
  insertJob,
  listFleetRepos as listFleetRepoRows,
  listRepos as listRepoRows,
  repoOwnerId,
  repoWorkspace,
  saveMode as readSaveMode,
  setRepoError,
  setRepoStatus,
  setSaveMode as writeSaveMode,
  setJobPhase,
  repoRunDeltas,
  reposScoredOverSample,
  updateJob,
  upsertRepo,
  type RepoRow,
} from "@codegraph/persistence";
import { indexRepo } from "@codegraph/analysis";
import { coalescePhases } from "@codegraph/analysis-model";
import { createIndexCacheStore, dropIndexCacheStore } from "@codegraph/fsx";
import { logger } from "@codegraph/observability";
import { cleanup, cloneRepo, getHeadHash, isGithubHost, resolveLocalDir, withToken } from "@codegraph/vcs";
import { emptyTrash } from "./trash";
import type { FleetRepo, IndexPhase, Job, JobStatus, RepoDrift, RepoSummary, RepoDetail, SaveMode, SourceType, VizGraph, IndexResult } from "./types";
import type { AdvisoryReport, ApiSurface, OwnershipReport, TaintReport, UnusedDependency } from "./types";

/**
 * Built lazily rather than at module load: this module is imported by route files
 * that Next may evaluate during build, and constructing the queue opens SQLite.
 */
let queue: ReturnType<typeof createJobQueue> | null = null;
const jobQueue = (): ReturnType<typeof createJobQueue> => (queue ??= createJobQueue());

/**
 * The host's concurrency ceiling for INLINE dispatch.
 *
 * Lazy for the same reason the queue is: `config` reads the environment, and a module-load
 * read would freeze whatever the environment happened to be at import time — which in the
 * test suite is before `beforeEach` sets it.
 */
let gate: SlotGate | null = null;
const slots = (): SlotGate => (gate ??= createSlotGate(config.maxConcurrentJobs));

/** Test seam: drop the gate so the next dispatch reads the current config. */
export function resetSlotGateForTests(): void {
  gate = null;
}

/**
 * Recover jobs that the previous process was running when it exited.
 *
 * Inline mode only — see `abandonOrphanedJobs`. Runs ONCE per process, at the first dispatch
 * rather than at import: a module-level call would fire during Next's build-time collection of
 * this route graph, against whatever database `dataDir()` resolved to then.
 */
let recovered = false;
function recoverOrphanedJobs(): void {
  if (recovered || config.useWorker) return;
  recovered = true;
  const n = abandonOrphanedJobs();
  if (n > 0) logger.warn("Recovered jobs left behind by a previous process", { jobs: n });
}

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

/**
 * A nullable analysis column as either a one-key object or NO key at all.
 *
 * `exactOptionalPropertyTypes` is on, so `{ ownership: undefined }` and `{}` are different
 * types — and here they are also different CLAIMS. These columns are NULL for every repository
 * indexed before migration 007, and a consumer must be able to tell "this run predates the
 * analysis, re-index it" from "we analysed and found nothing", which is a present report with
 * empty arrays. Spreading the result of this keeps the key absent in the first case instead of
 * flattening both into the same shape.
 *
 * A malformed blob degrades to absent rather than throwing, matching `parseColumn`: a row that
 * cannot be read is one we have no analysis for, which is exactly what absent means.
 */
function optionalReport<K extends string, T>(key: K, raw: string | null): Partial<Record<K, T>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null ? {} : ({ [key]: parsed } as Record<K, T>);
  } catch {
    return {};
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
 *
 * WHAT THE REPO ROW IS KEYED ON, since P0.9: (owner, source type, canonical target), resolved
 * by `upsertRepo`. This used to mint a fresh UUID per submission, so re-indexing inserted a
 * SECOND repository — the dashboard listed one codebase twice with two different scores and no
 * way to tell which was current. The id now survives a re-index, which is also what makes
 * every `/repos/<id>` link and bookmark keep working across one.
 */
export function createIndexJob(
  source: string,
  sourceType: SourceType,
  githubToken?: string,
  ownerId?: number | null,
): CreateIndexJobResult {
  recoverOrphanedJobs();
  const jobId = randomUUID();
  const name = sourceType === "git" ? gitName(source) : path.basename(source.replace(/\/+$/, "")) || source;

  const { id: repoId, previousStatus } = upsertRepo({
    // Used only if this target has no row yet; `upsertRepo` returns the existing id otherwise.
    id: randomUUID(),
    url: source,
    name,
    sourceType,
    ownerId: ownerId ?? null,
    createdAt: Date.now(),
  });

  // INLINE MODE (`CG_USE_WORKER=false`) — what `next dev` and the test suite use. The
  // deployed default is now the worker (see `config.useWorker`), but this path stays
  // fully supported because a second process is the wrong shape for a dev server.
  //
  // The dispatch goes through the host slot gate rather than straight to `runJob`. The
  // per-repo mutex below only serialises ONE repository; ten different repositories
  // submitted at once used to mean ten concurrent parses on a 0.5 vCPU box. Over the
  // ceiling the job WAITS, holding a `queued` row that looks exactly like one waiting
  // for a worker, so the caller and the UI need not know which mode is running.
  if (!config.useWorker) {
    // The mutex the worker path gets from `enqueue`, which this path never needed while every
    // submission produced its own repo row. Now that a re-submission lands on the SAME row it
    // does: two runs sharing one workspace directory race on every file in it, and the loser's
    // result silently wins. Both conditions are required — a busy status with no live job is a
    // row a crashed process left behind, and refusing that would strand the repository.
    const live = previousStatus !== null && BUSY_STATUSES[previousStatus as JobStatus]
      ? findLiveJobForRepo(repoId)
      : null;
    if (live) return { ok: false, reason: "repo-busy", jobId: live.id, repoId };

    setRepoStatus(repoId, "queued");
    insertJob(jobId, repoId);
    void slots().run(() => runJob(jobId, repoId, source, sourceType, githubToken));
    return { ok: true, jobId, repoId, deduplicated: false };
  }

  setRepoStatus(repoId, "queued");

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

/**
 * The persisted phase, or null.
 *
 * Tolerant on purpose: the column is written by two independent processes, and a phase
 * that cannot be parsed must render as "no phase" rather than break the poll the whole
 * progress UI runs on.
 */
function parsePhase(raw: string | null): IndexPhase | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as { stage?: unknown; done?: unknown; total?: unknown };
    if (typeof p.stage !== "string" || p.stage === "") return null;
    return {
      stage: p.stage,
      ...(typeof p.done === "number" ? { done: p.done } : {}),
      ...(typeof p.total === "number" ? { total: p.total } : {}),
    };
  } catch {
    return null;
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
    phase: parsePhase(r.phase_json),
  };
}

/**
 * Drift for a page of repos, in one query.
 *
 * `failed` comes from the REPO row and the deltas from the RUN rows, because a failed
 * index writes no run at all — a repo whose last attempt died would otherwise keep
 * showing the movement of the last run that succeeded, which is the reading least likely
 * to make anyone look at it.
 */
function driftFor(
  rows: ReadonlyArray<{ id: string; status?: string | null }>,
): Map<string, RepoDrift> {
  const deltas = repoRunDeltas(rows.map((r) => r.id));
  const out = new Map<string, RepoDrift>();
  for (const row of rows) {
    const d = deltas.get(row.id);
    const failed = row.status === "error";
    if (!d && !failed) continue;
    out.set(row.id, {
      findings: d?.findings ?? 0,
      scoreDelta: d?.scoreDelta ?? null,
      findingsDelta: d?.findingsDelta ?? null,
      failed,
    });
  }
  return out;
}

/** Repos visible to `viewer`: the shared public bucket plus the viewer's own. */
export function listRepos(viewer: ViewerId): RepoSummary[] {
  const rows = listRepoRows(viewer);
  const drift = driftFor(rows);
  // One statement for the page, beside the drift query: the dashboard ranks these rows by
  // score, so it has to know which of those scores are samples.
  const sampled = reposScoredOverSample(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    name: r.name,
    sourceType: (r.source_type || "git") as SourceType,
    status: r.status as JobStatus,
    score: r.score ?? null,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? null,
    drift: drift.get(r.id) ?? null,
    capHit: sampled.has(r.id),
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
  const rows = listFleetRepoRows(viewer);
  // `status = 'done'` is in this query's WHERE clause, so no row here can be a failed
  // index — the dashboard is the view that sees those.
  const drift = driftFor(rows);
  const sampled = reposScoredOverSample(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    name: r.name,
    sourceType: (r.source_type || "git") as SourceType,
    score: r.score ?? null,
    loc: r.loc ?? 0,
    dependencies: parseDependencies(r.deps),
    // Already selected by `listFleetRepoRows`; it was simply never carried out of the row.
    packageNames: parseDependencies(r.package_names_json),
    drift: drift.get(r.id) ?? null,
    capHit: sampled.has(r.id),
  }));
}

/** Lean ownership lookup for authz checks. */
export function getRepoOwnerId(id: string): number | null | undefined {
  return repoOwnerId(id);
}

function toRepoDetail(r: RepoRow): RepoDetail {
  return {
    // One repo, so `driftFor` runs its single-statement query over a one-element list
    // rather than this path having a second, subtly different definition of movement.
    drift: driftFor([r]).get(r.id) ?? null,
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
    /**
     * Spread rather than assigned, because `exactOptionalPropertyTypes` makes an explicit
     * `undefined` different from an absent key — and the difference is the whole contract
     * here. A NULL column means the run predates the analysis, which every consumer renders
     * as "not analysed"; writing `ownership: undefined` would satisfy the type while a
     * present-but-empty report and a missing one became indistinguishable downstream.
     */
    ...optionalReport<"ownership", OwnershipReport>("ownership", r.ownership_json),
    ...optionalReport<"apiSurface", ApiSurface>("apiSurface", r.api_surface_json),
    ...optionalReport<"taint", TaintReport>("taint", r.taint_json),
    ...optionalReport<"unusedDependencies", readonly UnusedDependency[]>("unusedDependencies", r.unused_deps_json),
    ...optionalReport<"advisories", AdvisoryReport>("advisories", r.advisories_json),
    ...optionalReport<"packageNames", readonly string[]>("packageNames", r.package_names_json),
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
  if (!r) return null;
  const detail = toRepoDetail(r);
  // Coverage is a property of a RUN, not of the repo row (LLD §8), so it is joined here rather
  // than duplicated into `repos`. Null for anything indexed before ADR-008, which the UI must
  // render as unknown rather than as complete.
  const coverage = latestRunCoverage(id) as RepoDetail["coverage"] | null;
  // `capHit` is repeated onto the summary half of the shape so a `RepoDetail` handed to a
  // list-shaped consumer cannot read as "walk finished" while its own coverage says otherwise.
  return coverage ? { ...detail, coverage, capHit: coverage.capHit } : detail;
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
 * Delete a repo, its jobs, its trash, and its incremental index cache. Removes the on-disk
 * workspace only for git clones (a "local" workspace is the user's real folder — never
 * touched); trash blobs always live under our own data dir, so those are purged regardless
 * of source type.
 */
export function deleteRepo(id: string, viewer: ViewerId): boolean {
  // Read the location BEFORE the row goes away, but delete through the scoped
  // repository so a non-owner cannot remove anything.
  const location = repoWorkspace(id);
  const removed = deleteRepoRow(id, viewer);
  if (!removed) return false;
  if (location?.source_type === "git" && location.workspace_dir) cleanup(location.workspace_dir);
  emptyTrash(id);
  /**
   * The cache slot outlives everything else if nobody drops it: it is keyed by the workspace
   * ROOT, not by the repo id, so it is not reachable from any row once the row is gone and no
   * sweeper would ever find it. Index-then-delete cycles would leave one dead manifest each
   * on the same disk as the database.
   *
   * Dropped for a LOCAL source too, even though the folder itself is the user's: the cache
   * lives in our data dir either way, and it is the derived artefact, not their file.
   */
  if (location?.workspace_dir) {
    dropIndexCacheStore(path.join(dataDir(), "index-cache"), location.workspace_dir);
  }
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
      // Same absent-vs-empty contract as `toRepoDetail`. This feeds the Timeline's HEAD fast
      // path, which reuses a stored result instead of re-indexing the same commit — so a
      // fabricated empty report here would be indistinguishable from a real one downstream.
      ...optionalReport<"ownership", OwnershipReport>("ownership", r.ownership_json),
      ...optionalReport<"apiSurface", ApiSurface>("apiSurface", r.api_surface_json),
      ...optionalReport<"taint", TaintReport>("taint", r.taint_json),
      ...optionalReport<"unusedDependencies", readonly UnusedDependency[]>("unusedDependencies", r.unused_deps_json),
      ...optionalReport<"advisories", AdvisoryReport>("advisories", r.advisories_json),
    ...optionalReport<"packageNames", readonly string[]>("packageNames", r.package_names_json),
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

/**
 * Index `root` and write the result everywhere a finished run has to appear.
 *
 * Extracted from `runJob` so the FIRST index and a RE-INDEX cannot drift: the two
 * differ only in how they obtain `root` (clone vs. an existing workspace), and every
 * line after that is the write path — `completeRepoIndex` for the repo row, plus
 * `recordRun` for the run/findings rows. A second hand-copied version of this tail is
 * exactly how the `findings` table went stale before (see the comment on `recordRun`
 * below): one path wrote the rows and the other did not, and nothing failed loudly.
 */
async function indexAndRecord(
  jobId: string,
  repoId: string,
  root: string,
  sourceType: SourceType,
  startedAt: number,
): Promise<void> {
  setJob(jobId, "indexing", 30, "Initializing Tree-sitter parsers…");
  await initTreeSitter();

  setJob(jobId, "indexing", 55, "Building knowledge graph…");
  setRepoStatus(repoId, "indexing");
  // The incremental cache slot, keyed by the ROOT rather than the repo id: the payload's
  // validity is a property of the bytes on disk (a per-file CONTENT HASH — never mtime or
  // size, which a same-second rewrite leaves untouched), so two repo rows
  // pointing at one local folder legitimately share a slot, and a workspace re-cloned to a
  // different path gets a fresh one instead of a stale hit. `@codegraph/fsx` owns the file
  // format and `@codegraph/analysis` owns the payload; this line only decides WHERE, which
  // is the one thing neither of those layers may know. A missing/corrupt/unwritable slot
  // degrades to a full index and never to a failure — neither store method throws.
  const result = await indexRepo(root, {
    cache: createIndexCacheStore(path.join(dataDir(), "index-cache"), root),
    // Live phase for the progress poll. `setJobPhase` writes one column and nothing else,
    // so it cannot contradict the coarse state `setJob` above owns; `coalescePhases` holds
    // it to ~2 writes/second, since the pipeline emits every 15 files and a row write per
    // file would cost more than the analysis it is reporting on.
    onPhase: coalescePhases((phase) => setJobPhase(jobId, JSON.stringify(phase))),
  });
  // The reuse decision is otherwise invisible: it changes no output, and the report is not
  // persisted on the repo row. One line per run is what makes "the cache is silently never
  // hitting" and "the cache is silently serving a stale graph" diagnosable at all.
  logger.info("index complete", {
    repoId,
    mode: result.incremental?.mode,
    reason: result.incremental?.reason,
    reused: result.incremental?.filesReused,
    changed: result.incremental?.filesChanged,
    cacheWritten: result.incremental?.cacheWritten,
  });

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
    // `?? null` and not `?? "{}"`: a run that produced no report leaves the column NULL, which
    // readers render as "not analysed". Serialising an empty object here would claim the
    // analysis ran and found nothing.
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
      startedAt,
      finishedAt: Date.now(),
    },
    result.issues
  );

  setJob(jobId, "done", 100, `Done — Health Score ${result.score}/100`);
}

/**
 * Why an indexing run failed, in the vocabulary the CLIENT is allowed to see.
 *
 * `failJob` used to hand `e.message` straight to the job row, which the jobs API returns
 * verbatim. For the commonest failure there is — a URL that does not resolve to a repo —
 * that rendered this to an anonymous visitor on the landing page:
 *
 *   Command failed: git -c http.followRedirects=false clone --depth 50 https://example.com/foo/bar
 *   /app/data/workspaces/6ee8aa2a-3635-4830-b9d6-2c456b9216b9
 *   fatal: repository 'https://example.com/foo/bar/' not found
 *
 * Three disclosures (absolute data-dir path, the internal workspace UUID, the exact git
 * invocation and its flags) to deliver one useful token: `not found`. That is F023 on the
 * one route every visitor hits first, and it is also unreadable — the actionable sentence
 * is the last two words of the third line.
 *
 * The patterns below are matched against `git`'s and node's REAL output rather than
 * invented: see `packages/vcs/src/acquire.ts` for the invocation that produces them
 * (`GIT_TERMINAL_PROMPT=0` is why an auth failure says "terminal prompts disabled"
 * instead of hanging, and `http.followRedirects=false` is why a moved repo reports a
 * redirect refusal), and `resolveLocalDir` for the two local-path throws.
 */
export type IndexFailureCause =
  | "repo-not-found"
  | "auth-required"
  | "host-unreachable"
  | "clone-timeout"
  | "disk-full"
  | "not-a-git-repo"
  | "blocked-url"
  | "local-access-denied"
  | "local-path-unreadable"
  | "unknown";

/**
 * One sentence per cause, each ending in something the reader can DO. No cause may
 * interpolate any part of the raw error: the whole point of the indirection is that these
 * strings are constants an operator can read here and know are safe to ship.
 */
export const INDEX_FAILURE_MESSAGES: Record<IndexFailureCause, string> = {
  "repo-not-found": "Repository not found. Check the URL, or sign in if it is private.",
  "auth-required":
    "This repository is private. Sign in with GitHub and pick it from your repository list, or use a public URL.",
  "host-unreachable":
    "Could not reach that host. Check the domain is spelled correctly and is reachable from the public internet.",
  "clone-timeout":
    "The clone took too long and was stopped. Try again, or index a smaller repository.",
  "disk-full":
    "The server ran out of disk space. Delete an indexed repository to free space, then try again.",
  "not-a-git-repo":
    "That location is not a git repository. Point CodeGraph at a git checkout or a git URL.",
  "blocked-url":
    "That URL was refused. Use a public https git URL — private, loopback and redirecting hosts are not accepted.",
  "local-access-denied":
    "Local-folder indexing is disabled on this deployment. Use a git URL instead.",
  "local-path-unreadable":
    "That folder could not be read. Check it exists on the server and is a directory the app can read.",
  // Deliberately not "Indexing failed" — the job's own message already says that directly
  // above it, and a card that says the same four words twice reads as a rendering bug.
  unknown: "Indexing did not complete. Retry, and if it keeps failing check the source is a public git URL.",
};

/**
 * Ordered because the haystacks OVERLAP. `fatal: unable to access '…': Could not resolve
 * host: x` carries git's generic access prefix as well as the DNS cause, and a clone the
 * timeout killed carries nothing but "Command failed" — so structural evidence (the
 * `killed` flag `child_process` sets when it sends SIGTERM at `cloneTimeoutMs`) is
 * consulted before text, and the specific text before the generic.
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [IndexFailureCause, readonly string[]]> = [
  ["local-access-denied", ["local-folder indexing and server-side folder browsing are disabled", "outside the configured local-access root"]],
  ["local-path-unreadable", ["path does not exist", "not a directory", "eacces"]],
  ["blocked-url", ["invalid repository url", "not allowed", "unable to find remote helper", "unable to update url base from redirection", "loopback/private/link-local"]],
  ["auth-required", ["authentication failed", "could not read username", "terminal prompts disabled", "invalid username or password", "access denied", "requested url returned error: 401", "requested url returned error: 403", "permission denied (publickey"]],
  ["repo-not-found", ["not found", "requested url returned error: 404"]],
  ["host-unreachable", ["could not resolve host", "failed to connect", "connection refused", "network is unreachable", "no route to host", "temporary failure in name resolution", "enotfound", "econnrefused", "connection timed out"]],
  ["disk-full", ["enospc", "no space left on device"]],
  ["not-a-git-repo", ["not a git repository"]],
  ["clone-timeout", ["timed out", "etimedout"]],
];

/**
 * A raw exception → a stable cause and the safe sentence that goes with it.
 *
 * `stderr` is folded into the haystack alongside `message` because `execFile`'s rejection
 * splits the evidence across both, and which half carries the diagnosis depends on how
 * much git managed to print before it died.
 */
export function classifyIndexFailure(e: unknown): { readonly cause: IndexFailureCause; readonly message: string } {
  // `child_process` killing the clone itself IS the timeout: it sends SIGTERM at
  // `cloneTimeoutMs` and git dies without printing anything that says so, so this is the
  // only evidence there will ever be for the commonest slow-repo failure.
  const killed = e as { killed?: unknown; signal?: unknown } | null;
  if (killed?.killed === true || killed?.signal === "SIGTERM") {
    return { cause: "clone-timeout", message: INDEX_FAILURE_MESSAGES["clone-timeout"] };
  }
  const withStderr = e as { stderr?: unknown } | null;
  const stderr = typeof withStderr?.stderr === "string" ? withStderr.stderr : "";
  const haystack = `${e instanceof Error ? e.message : String(e)}\n${stderr}`.toLowerCase();
  for (const [cause, needles] of FAILURE_PATTERNS) {
    if (needles.some((n) => haystack.includes(n))) return { cause, message: INDEX_FAILURE_MESSAGES[cause] };
  }
  return { cause: "unknown", message: INDEX_FAILURE_MESSAGES.unknown };
}

/**
 * Both inline runners end the same way: the job row carries the message, the repo row the state.
 *
 * Progress is whatever the run had REACHED, not 100. Hardcoding 100 drew a full bar above
 * the word "failed" — the same shape a finished run makes — so the one glanceable signal
 * on the page said the opposite of the text beside it. Stopping the bar where the work
 * stopped also says something true: a failure at 15% is a clone that never landed, a
 * failure at 70% is a repository that cloned and would not parse.
 */
function failJob(jobId: string, repoId: string, e: unknown): void {
  const { cause, message } = classifyIndexFailure(e);
  // The raw text is the operator's ONLY copy — it is deliberately absent from every
  // response — so it is logged with the ids needed to tie it back to a user's report.
  logger.warn("indexing failed", { repoId, jobId, cause, err: e instanceof Error ? e.message : String(e) });
  setJob(jobId, "error", getJob(jobId)?.progress ?? 0, "Indexing failed", message);
  setRepoError(repoId, "error", message);
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

    await indexAndRecord(jobId, repoId, root, sourceType, jobStartedAt);
  } catch (e) {
    failJob(jobId, repoId, e);
  }
}

/**
 * Re-index an EXISTING repo in place: no clone, no new repo row, no new repo id.
 *
 * The workspace is the one the editor and the git route have been mutating, so the
 * whole first half of `runJob` (clone / resolve a source) is not just unnecessary but
 * wrong — a fresh clone would discard uncommitted edits, and minting a new repoId
 * would strand every URL, run record and finding pointing at the old one. That
 * `createIndexJob` is the only entry point is precisely why nothing could refresh a
 * repository (AUDIT_2026-07-12 F098).
 */
async function runReindexJob(
  jobId: string,
  repoId: string,
  root: string,
  sourceType: SourceType,
): Promise<void> {
  const jobStartedAt = Date.now();
  // Claim the repo SYNCHRONOUSLY, before the first `await`. `indexAndRecord` does not
  // reach `setRepoStatus("indexing")` until Tree-sitter has initialised, and two POSTs
  // to /reindex inside that window would both pass the `BUSY_STATUSES` check and index
  // one workspace twice. Everything above this line in the function body still runs in
  // the caller's tick, so by the time `startReindex` returns the row already says so.
  setRepoStatus(repoId, "indexing");
  try {
    await indexAndRecord(jobId, repoId, root, sourceType, jobStartedAt);
  } catch (e) {
    failJob(jobId, repoId, e);
  }
}

/**
 * Statuses that mean a run already owns this workspace. Re-indexing under a live run
 * would have two passes writing one repo row and one cache slot, and the loser's
 * result silently wins.
 */
const BUSY_STATUSES: Partial<Record<JobStatus, true>> = { cloning: true, indexing: true, scoring: true };

/**
 * Start a re-index, exposing the inline run's promise so the scheduler can tell when
 * the work is actually over.
 *
 * `reindexRepo` below cannot return that promise (its contract is a synchronous
 * result for an HTTP handler), and the scheduler cannot do without it: if "in flight"
 * ended at enqueue time, the second save during a 40s index would schedule a run that
 * `BUSY_STATUSES` then refuses, and that edit would never be indexed at all.
 *
 * Under `config.useWorker` the promise is necessarily empty — the run happens in
 * another process and this one only wrote a row. The queue's own per-repo mutex is
 * what serialises runs there, and it returns the live job rather than a second one.
 */
type StartedReindex =
  | { readonly ok: true; readonly jobId: string; readonly done: Promise<void> }
  | { readonly ok: false; readonly reason: "busy" | "no-workspace" };

function startReindex(repoId: string): StartedReindex {
  recoverOrphanedJobs();
  const ws = getWorkspaceDir(repoId);
  if (!ws) return { ok: false, reason: "no-workspace" };

  const repo = getRepoForSystem(repoId);
  if (repo && BUSY_STATUSES[repo.status]) return { ok: false, reason: "busy" };

  const jobId = randomUUID();

  // Same two modes as `createIndexJob`, and the same host ceiling: a re-index is the
  // identical pipeline, so it must not be the way to get around the bound.
  if (!config.useWorker) {
    insertJob(jobId, repoId);
    return {
      ok: true,
      jobId,
      done: slots().run(() => runReindexJob(jobId, repoId, ws.dir, ws.sourceType)),
    };
  }

  const queued = jobQueue().enqueue({
    id: jobId,
    repoId,
    kind: "analyze",
    payload: {
      repoId,
      source: repo?.url ?? ws.dir,
      sourceType: ws.sourceType,
      // The one thing that makes this different from a first index: the handler must
      // NOT clone over a workspace the user has been editing.
      workspaceReady: true,
    },
  });
  if (!queued.ok) return { ok: false, reason: "busy" };
  return { ok: true, jobId: queued.jobId, done: Promise.resolve() };
}

/**
 * Re-index a repository the caller already has, reusing its row and its workspace.
 *
 * Fire-and-forget by design: the caller gets the job id to attach a progress stream to,
 * exactly as `createIndexJob` does, and a re-indexed repo is indistinguishable from a
 * freshly indexed one because both go through `indexAndRecord`.
 */
export function reindexRepo(repoId: string): { ok: boolean; jobId?: string; reason?: string } {
  const started = startReindex(repoId);
  return started.ok ? { ok: true, jobId: started.jobId } : { ok: false, reason: started.reason };
}

/**
 * Quiet period before an edit-triggered re-index runs.
 *
 * The editor autosaves roughly once per second. An index per save is a CPU storm on the
 * 0.5 vCPU container — a full pass is seconds of Tree-sitter parsing, so runs would
 * overlap-and-refuse forever and the workspace would never converge. 10s is above any
 * plausible inter-keystroke gap and below the point where a user notices the intel is
 * behind their last save.
 */
export const REINDEX_QUIET_MS = 10_000;

/**
 * What the scheduler runs when a repo's quiet period expires. Injectable for tests.
 *
 * Returns whether the attempt should be RE-ARMED rather than treated as done. A refusal is
 * not a failure — the repo was busy — but treating it as done is what silently loses the
 * user's last edit, so the two outcomes have to be distinguishable here.
 */
type ReindexRunner = (repoId: string) => Promise<{ deferred: boolean }>;

/**
 * How many consecutive refusals to sit through before giving up on a repo.
 *
 * Bounded, because "busy" can be permanent: a repo row stuck at `indexing` after a killed
 * executor refuses every re-index forever, and an unbounded retry would then re-arm a timer
 * every 10s for the life of the process. Six deferrals is a minute of patience — longer than
 * any index this container can complete — after which the staleness is logged rather than
 * chased.
 */
const REINDEX_MAX_DEFERRALS = 6;

interface ReindexState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  /** A trigger arrived mid-run: schedule exactly ONE more pass, never a queue of them. */
  pending: boolean;
  /** Consecutive refusals so far, reset by any attempt that actually started work. */
  deferrals: number;
  run: ReindexRunner;
}

/**
 * PER-PROCESS state, therefore BEST-EFFORT under a multi-process deployment: two Next
 * server processes debounce independently, so a workspace edited through both can see
 * two runs where one was intended. That is acceptable and deliberate — the losing run
 * is refused by `BUSY_STATUSES` or by the queue's per-repo mutex, so the failure mode
 * is a wasted index, not a corrupted one. Cross-process coalescing would need the
 * debounce to live in the jobs table, which is a scheduler, not a Map.
 */
const reindexState = new Map<string, ReindexState>();

const defaultReindexRunner: ReindexRunner = async (repoId) => {
  const started = startReindex(repoId);
  if (!started.ok) {
    // `busy` is the interesting one, and it is the COMMON case under `CG_USE_WORKER=true`:
    // that branch of `startReindex` can only return an empty promise (the run happens in
    // another process), so `running` clears at ENQUEUE time and the very next trigger lands
    // while the queue's per-repo mutex still holds. Treating that as "done" is what silently
    // discarded the user's last edit — the index would stay stale until something else
    // happened to trigger a run. Deferring re-arms the quiet period instead.
    logger.info("scheduled re-index deferred", { repoId, reason: started.reason });
    return { deferred: started.reason === "busy" };
  }
  await started.done;
  return { deferred: false };
};

function armReindex(repoId: string, state: ReindexState): void {
  const timer = setTimeout(() => void fireReindex(repoId, state), REINDEX_QUIET_MS);
  // A pending re-index must never be the reason a process refuses to exit; the work is
  // best-effort and the next trigger after restart re-arms it.
  timer.unref?.();
  state.timer = timer;
}

async function fireReindex(repoId: string, state: ReindexState): Promise<void> {
  state.timer = null;
  state.running = true;
  let deferred = false;
  try {
    // `await` inside try rather than `.catch()` on the call: a runner that throws
    // SYNCHRONOUSLY must be caught too, or the rejection escapes to the process.
    const outcome = await state.run(repoId);
    deferred = outcome?.deferred === true;
  } catch (e) {
    // Never rejects into the caller: `scheduleReindex` is called from route handlers
    // that have already answered the client, and an unhandled rejection there is a
    // process-level crash for work nobody is waiting on. A THROWN failure is not deferred:
    // it already consumed the work, and retrying it on a timer would loop on a broken repo.
    logger.warn("scheduled re-index failed", { repoId, err: e instanceof Error ? e.message : String(e) });
  } finally {
    state.running = false;
    if (deferred && state.deferrals + 1 >= REINDEX_MAX_DEFERRALS) {
      // Give up loudly. Silence here reads exactly like success, and the difference is
      // whether the code intelligence on screen matches the files on disk.
      logger.warn("scheduled re-index abandoned; index may be stale", { repoId, deferrals: state.deferrals + 1 });
      reindexState.delete(repoId);
    } else if (deferred) {
      state.deferrals++;
      state.pending = false;
      armReindex(repoId, state);
    } else if (state.pending) {
      state.deferrals = 0;
      state.pending = false;
      // Re-arm the full quiet period rather than running immediately: the triggers that
      // set `pending` were saves, and more are likely still coming.
      armReindex(repoId, state);
    } else if (state.timer === null) {
      // Nothing outstanding — drop the entry so the Map cannot grow one dead record per
      // repo the process has ever seen.
      reindexState.delete(repoId);
    }
  }
}

/**
 * Coalescing trigger for "the workspace changed, the index is stale".
 *
 * Contract: N calls inside the quiet period produce exactly ONE run; a call arriving
 * while a run is in flight produces exactly one follow-up run regardless of how many
 * arrive; a failing run neither rejects into the caller nor wedges the repo's slot.
 *
 * `run` is a parameter so the scheduler's timing contract is testable without the real
 * pipeline (which needs a workspace, Tree-sitter and SQLite); production callers pass
 * nothing and get `defaultReindexRunner`.
 */
export function scheduleReindex(repoId: string, run: ReindexRunner = defaultReindexRunner): void {
  const state = reindexState.get(repoId) ?? { timer: null, running: false, pending: false, deferrals: 0, run };
  state.run = run;
  reindexState.set(repoId, state);

  if (state.running) {
    state.pending = true;
    return;
  }
  // Restart the quiet period on every call — that is what makes a burst of autosaves
  // one run instead of one run per save.
  clearTimeout(state.timer ?? undefined);
  armReindex(repoId, state);
}
