// Regression tests for the fixes in docs/AUDIT_2026-07-12.md's Critical/High
// bucket: F002 (executor sandbox symlink escape), F003 (workspace.ts
// resolveSafe symlink escape), F004 (credential leak into job error text),
// F005 (job ownership), F006 (github-host gate before token attachment),
// F010 (OAuth returnTo open redirect). Each suite locks in the fix AND
// verifies the corresponding legitimate path still works unchanged.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { isGithubHost } from "@/lib/gitops";
import { resolveSafe, WorkspacePathError } from "@/lib/workspace";
import { redactCredentials, cloneRepo } from "@/lib/indexer";
import { isSafeReturnPath } from "@/lib/urlSafety";
import { executeFixes } from "@/lib/agents/executor";
import type { RepoDetail } from "@/lib/types";
import { db } from "@/lib/db";
import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/session";
import { GET as jobsGet } from "@/app/api/jobs/[id]/route";

// Isolated data dir + session secret so the jobs-ownership suite (the only
// one touching the DB/session machinery) never shares state with other
// test files. `db()` is lazily initialized on first call, so setting these
// after the (static, hoisted) imports but before any test runs is safe.
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-sechardening-"));
process.env.CG_DATA_DIR = dataDir;
process.env.CG_SESSION_SECRET = "test-secret-for-security-hardening";

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("isGithubHost (F006 — gate before ever attaching a token to a remote)", () => {
  it("accepts exact github.com URLs", () => {
    expect(isGithubHost("https://github.com/owner/repo")).toBe(true);
    expect(isGithubHost("https://github.com/owner/repo.git")).toBe(true);
  });

  it("rejects a non-github host, including hosts that merely contain 'github.com'", () => {
    expect(isGithubHost("https://evil.example/owner/repo")).toBe(false);
    expect(isGithubHost("https://github.com.evil.example/owner/repo")).toBe(false);
    expect(isGithubHost("https://notgithub.com/owner/repo")).toBe(false);
  });

  it("fails closed on a malformed URL", () => {
    expect(isGithubHost("not a url")).toBe(false);
    expect(isGithubHost("")).toBe(false);
  });
});

describe("resolveSafe (F003 — symlink-aware workspace containment)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cg-ws-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "cg-ws-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "top secret", "utf8");
  writeFileSync(path.join(root, "real.txt"), "hello", "utf8");
  mkdirSync(path.join(root, "sub"));
  symlinkSync(outside, path.join(root, "escape-dir"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-file.txt"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("still resolves ordinary in-workspace paths — no functional regression", () => {
    expect(resolveSafe(root, "real.txt")).toBe(path.join(root, "real.txt"));
    expect(resolveSafe(root, "sub")).toBe(path.join(root, "sub"));
    expect(resolveSafe(root, ".")).toBe(path.resolve(root));
  });

  it("still allows creating a new (not-yet-existing) file inside the real workspace", () => {
    expect(resolveSafe(root, "sub/new-file.txt")).toBe(path.join(root, "sub", "new-file.txt"));
  });

  it("still rejects lexical .. traversal", () => {
    expect(() => resolveSafe(root, "../../../etc/passwd")).toThrow(WorkspacePathError);
  });

  it("rejects a symlinked file that resolves outside the workspace", () => {
    expect(() => resolveSafe(root, "escape-file.txt")).toThrow(WorkspacePathError);
  });

  it("rejects a path reached through a symlinked directory", () => {
    expect(() => resolveSafe(root, "escape-dir/secret.txt")).toThrow(WorkspacePathError);
  });
});

describe("redactCredentials (F004 — never let a token reach a stored error message)", () => {
  it("strips userinfo from an embedded-token URL", () => {
    const msg = "Command failed: git clone https://x-access-token:ghp_SECRETTOKEN@github.com/o/r /tmp/dir";
    const clean = redactCredentials(msg);
    expect(clean).not.toContain("ghp_SECRETTOKEN");
    expect(clean).toContain("https://github.com/o/r");
  });

  it("leaves credential-free text untouched", () => {
    const msg = "fatal: repository 'https://github.com/o/r' not found";
    expect(redactCredentials(msg)).toBe(msg);
  });

  it("cloneRepo's real failure path never leaks the embedded token", async () => {
    // Loopback with nothing listening — connection-refused is immediate and
    // OS-level (doesn't depend on outbound network policy), unlike a
    // routed-but-unroutable address which can hang until git's own timeout.
    // Node's execFile rejection normally embeds the full argv (including
    // credentials) in the Error; this must come back redacted.
    const url = "https://x-access-token:ghp_SECRETTOKEN@127.0.0.1/owner/repo.git";
    await expect(cloneRepo(url)).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return !msg.includes("ghp_SECRETTOKEN");
    });
  }, 10_000);
});

describe("isSafeReturnPath (F010 — OAuth returnTo open-redirect guard)", () => {
  it("accepts ordinary same-origin relative paths", () => {
    expect(isSafeReturnPath("/")).toBe(true);
    expect(isSafeReturnPath("/repos/abc123")).toBe(true);
    expect(isSafeReturnPath("/fleet?tab=all")).toBe(true);
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(isSafeReturnPath("https://evil.example")).toBe(false);
    expect(isSafeReturnPath("//evil.example")).toBe(false);
    expect(isSafeReturnPath("/\\evil.example")).toBe(false);
    expect(isSafeReturnPath("evil.example")).toBe(false);
  });
});

describe("executeFixes sandbox walk (F002 — never follow a symlink out of the sandbox)", () => {
  it("skips a symlinked file pointing outside the sandbox instead of reading/editing through it", async () => {
    const src = mkdtempSync(path.join(tmpdir(), "cg-exec-src-"));
    const outside = mkdtempSync(path.join(tmpdir(), "cg-exec-outside-"));
    try {
      // A real, in-tree fixable file — proves normal files still get processed.
      writeFileSync(path.join(src, "real.ts"), "export function f() {\n  console.log('debug');\n}\n", "utf8");
      // Outside the sandbox, reachable only through the symlink below. If
      // walkCode ever followed it, this marker would leak into the diff.
      writeFileSync(path.join(outside, "secret.ts"), "console.log('OUTSIDE_SECRET_MARKER');\n", "utf8");
      symlinkSync(path.join(outside, "secret.ts"), path.join(src, "escape.ts"));

      const repo: RepoDetail = {
        id: "sym-e2e", url: src, name: "sym-e2e", status: "done", sourceType: "local",
        score: 0, createdAt: 0, finishedAt: 0, hasWorkspace: false, error: null,
        loc: 0, languages: [], graphStats: { nodes: 0, edges: 0, files: 0, dirs: 0, dependencies: 0 },
        dimensions: [], issues: [], dependencies: [], churnByFile: {},
        tree: { name: "/", path: ".", children: [] },
        viz: { nodes: [], edges: [], truncated: false },
        modules: { nodes: [], edges: [] },
        symbolGraph: { symbols: [], edges: [], truncated: false, stats: { symbols: 0, edges: 0, resolvedCalls: 0 } },
      };

      const result = await executeFixes(repo);
      expect(result.ok).toBe(true);
      // Legitimate in-tree file still got fixed — no functional regression.
      expect(result.edits.some((e) => e.file === "real.ts")).toBe(true);
      // Nothing reached through the symlink.
      expect(result.edits.some((e) => e.file.includes("escape"))).toBe(false);
      expect(result.pr?.diff.includes("OUTSIDE_SECRET_MARKER")).toBeFalsy();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("GET /api/jobs/:id ownership check (F005)", () => {
  const OWNER = 4001;
  const OTHER = 5002;

  function insertRepoAndJob(ownerId: number | null): { repoId: string; jobId: string } {
    const repoId = randomUUID();
    const jobId = randomUUID();
    db()
      .prepare(
        "INSERT INTO repos (id, url, name, source_type, status, owner_id, created_at) VALUES (?, ?, ?, 'git', 'done', ?, ?)"
      )
      .run(repoId, `https://github.com/x/${repoId}`, repoId, ownerId, Date.now());
    db()
      .prepare("INSERT INTO jobs (id, repo_id, status, progress, message) VALUES (?, ?, 'done', 100, 'Done')")
      .run(jobId, repoId);
    return { repoId, jobId };
  }

  function requestAs(userId: number | null, jobId: string): NextRequest {
    const headers = new Headers();
    if (userId !== null) {
      const payload = {
        userId, login: `user-${userId}`, name: null, avatarUrl: "", accessToken: "unused", issuedAt: Date.now(),
      };
      headers.set("cookie", `${SESSION_COOKIE_NAME}=${encryptSession(payload)}`);
    }
    return new NextRequest(`http://localhost/api/jobs/${jobId}`, { headers });
  }

  it("returns the job to its owner", async () => {
    const { jobId } = insertRepoAndJob(OWNER);
    const res = await jobsGet(requestAs(OWNER, jobId), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(200);
  });

  it("returns the job for a public-bucket (anonymously-indexed) repo to anyone", async () => {
    const { jobId } = insertRepoAndJob(null);
    const res = await jobsGet(requestAs(null, jobId), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(200);
  });

  it("denies a signed-in non-owner (404, matching the tenant-isolation model)", async () => {
    const { jobId } = insertRepoAndJob(OWNER);
    const res = await jobsGet(requestAs(OTHER, jobId), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(404);
  });

  it("denies an anonymous caller for a privately-owned repo's job", async () => {
    const { jobId } = insertRepoAndJob(OWNER);
    const res = await jobsGet(requestAs(null, jobId), { params: Promise.resolve({ id: jobId }) });
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent job id", async () => {
    const res = await jobsGet(requestAs(OWNER, "does-not-exist"), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });
});
