import { initTreeSitter } from "./codeintel/ast-extractor";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { db, dataDir } from "./db";
import { cloneRepo, indexRepo, cleanup, resolveLocalDir } from "./indexer";
import { withToken } from "./gitops";
import { emptyTrash } from "./trash";
import type { Job, JobStatus, RepoDetail, RepoSummary, SaveMode, SourceType, VizGraph } from "./types";

const EMPTY_VIZ: VizGraph = { nodes: [], edges: [], truncated: false };

function gitName(url: string): string {
  const m = url.replace(/\.git$/, "").match(/([^/]+\/[^/]+)\/?$/);
  return m ? m[1] : url;
}

export function createIndexJob(
  source: string,
  sourceType: SourceType,
  githubToken?: string
): { jobId: string; repoId: string } {
  const repoId = randomUUID();
  const jobId = randomUUID();
  const now = Date.now();
  const name = sourceType === "git" ? gitName(source) : path.basename(source.replace(/\/+$/, "")) || source;
  const d = db();
  d.prepare(
    "INSERT INTO repos (id, url, name, source_type, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)"
  ).run(repoId, source, name, sourceType, now);
  d.prepare(
    "INSERT INTO jobs (id, repo_id, status, progress, message) VALUES (?, ?, 'queued', 0, 'Queued')"
  ).run(jobId, repoId);

  // Fire-and-forget: runs in the Node server process.
  void runJob(jobId, repoId, source, sourceType, githubToken);
  return { jobId, repoId };
}

function setJob(jobId: string, status: JobStatus, progress: number, message: string, error?: string) {
  db()
    .prepare("UPDATE jobs SET status=?, progress=?, message=?, error=? WHERE id=?")
    .run(status, progress, message, error ?? null, jobId);
}

function setRepoStatus(repoId: string, status: JobStatus) {
  db().prepare("UPDATE repos SET status=? WHERE id=?").run(status, repoId);
}

async function runJob(jobId: string, repoId: string, source: string, sourceType: SourceType, githubToken?: string) {
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
      let cloneUrl = source;
      if (githubToken) {
        try {
          if (new URL(source).hostname === "github.com") cloneUrl = withToken(source, githubToken);
        } catch {
          /* malformed URL — cloneRepo's own validation will reject it below */
        }
      }
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
    const result = indexRepo(root);

    setJob(jobId, "scoring", 85, "Computing Health Score…");
    setRepoStatus(repoId, "scoring");

    // Keep the on-disk checkout around as a persistent workspace for the
    // built-in editor (git clones are no longer deleted after indexing;
    // local folders were never copied in the first place).
    db()
      .prepare(
        `UPDATE repos SET status='done', score=?, loc=?, languages=?, graph=?, dimensions=?, issues=?, deps=?, viz=?, tree=?, modules=?, symbols=?, workspace_dir=?, finished_at=?
         WHERE id=?`
      )
      .run(
        result.score,
        result.loc,
        JSON.stringify(result.languages),
        JSON.stringify(result.graph),
        JSON.stringify(result.dimensions),
        JSON.stringify(result.issues),
        JSON.stringify(result.dependencies),
        JSON.stringify(result.viz),
        JSON.stringify(result.tree),
        JSON.stringify(result.modules),
        JSON.stringify(result.symbolGraph),
        root,
        Date.now(),
        repoId
      );
    setJob(jobId, "done", 100, `Done — Health Score ${result.score}/100`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setJob(jobId, "error", 100, "Indexing failed", msg);
    db()
      .prepare("UPDATE repos SET status='error', error=?, finished_at=? WHERE id=?")
      .run(msg, Date.now(), repoId);
  }
}

export function getJob(jobId: string): Job | null {
  const r = db()
    .prepare("SELECT id, repo_id, status, progress, message, error FROM jobs WHERE id=?")
    .get(jobId) as
    | { id: string; repo_id: string; status: JobStatus; progress: number; message: string; error: string | null }
    | undefined;
  if (!r) return null;
  return { id: r.id, repoId: r.repo_id, status: r.status, progress: r.progress, message: r.message, error: r.error };
}

export function listRepos(): RepoSummary[] {
  const rows = db()
    .prepare(
      "SELECT id, url, name, source_type, status, score, created_at, finished_at FROM repos ORDER BY created_at DESC LIMIT 100"
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    url: r.url as string,
    name: r.name as string,
    sourceType: ((r.source_type as string) || "git") as SourceType,
    status: r.status as JobStatus,
    score: (r.score as number | null) ?? null,
    createdAt: r.created_at as number,
    finishedAt: (r.finished_at as number | null) ?? null,
  }));
}

/** Delete a repo, its jobs, and its trash. Removes the on-disk workspace only
 *  for git clones (a "local" workspace is the user's real folder — never
 *  touched); trash blobs always live under our own data dir, so those are
 *  purged regardless of source type. */
export function deleteRepo(id: string): boolean {
  const d = db();
  const row = d.prepare("SELECT source_type, workspace_dir FROM repos WHERE id=?").get(id) as
    | { source_type: string; workspace_dir: string | null }
    | undefined;
  d.prepare("DELETE FROM jobs WHERE repo_id = ?").run(id);
  const res = d.prepare("DELETE FROM repos WHERE id = ?").run(id);
  if (row?.source_type === "git" && row.workspace_dir) cleanup(row.workspace_dir);
  emptyTrash(id);
  return Number(res.changes ?? 0) > 0;
}

export function getRepo(id: string): RepoDetail | null {
  const r = db().prepare("SELECT * FROM repos WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    url: r.url as string,
    name: r.name as string,
    sourceType: ((r.source_type as string) || "git") as SourceType,
    status: r.status as JobStatus,
    hasWorkspace: Boolean(r.workspace_dir),
    score: (r.score as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    loc: (r.loc as number) ?? 0,
    languages: JSON.parse((r.languages as string) || "[]"),
    graph: JSON.parse((r.graph as string) || "{}"),
    dimensions: JSON.parse((r.dimensions as string) || "[]"),
    issues: JSON.parse((r.issues as string) || "[]"),
    dependencies: JSON.parse((r.deps as string) || "[]"),
    viz: JSON.parse((r.viz as string) || "null") || EMPTY_VIZ,
    tree: JSON.parse((r.tree as string) || "null") || { name: "/", path: ".", children: [] },
    modules: JSON.parse((r.modules as string) || "null") || { nodes: [], edges: [] },
    symbolGraph: JSON.parse((r.symbols as string) || "null") || { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } },
    createdAt: r.created_at as number,
    finishedAt: (r.finished_at as number | null) ?? null,
  };
}

/** Resolve the on-disk workspace root for a repo, or null if not indexed yet. */
export function getWorkspaceDir(id: string): { dir: string; sourceType: SourceType } | null {
  const r = db().prepare("SELECT workspace_dir, source_type FROM repos WHERE id=?").get(id) as
    | { workspace_dir: string | null; source_type: string }
    | undefined;
  if (!r || !r.workspace_dir) return null;
  return { dir: r.workspace_dir, sourceType: (r.source_type as SourceType) || "git" };
}

export function getSaveMode(id: string): SaveMode {
  const r = db().prepare("SELECT save_mode FROM repos WHERE id=?").get(id) as { save_mode: string } | undefined;
  return ((r?.save_mode as SaveMode) || "local");
}

export function setSaveMode(id: string, mode: SaveMode): void {
  db().prepare("UPDATE repos SET save_mode=? WHERE id=?").run(mode, id);
}
