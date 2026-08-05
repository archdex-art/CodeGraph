import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as VcsModule from "@codegraph/vcs";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-route-limits-"));
process.env["CG_DATA_DIR"] = dataDir;

/**
 * Two abuse gates on the per-repo routes, from the security review.
 *
 * Both are tested through the real handlers rather than a helper, because in both cases
 * the bug was WHERE the check sat, not what it computed: the limiter has to run before
 * `requireWorkspace` (authz is not protection when the public bucket is anonymous), and
 * `err` has to know which op it is reporting for. A unit test of `rateLimit` alone —
 * which already exists in security-hardening-2.test.ts — cannot see either of those.
 */

// A push failure carries the token-bearing remote in stderr; the forwarding path must
// still redact it (F004/F017). Everything else carries the server's absolute workspace
// path, which is the F023 disclosure the narrowing exists to stop.
const PUSH_STDERR =
  "! [rejected] main -> main (non-fast-forward)\n" +
  "error: failed to push some refs to 'https://x-access-token:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/o/r.git'";
const STATUS_STDERR = `fatal: not a git repository: '${dataDir}/workspaces/repo-git/.git'`;

function gitFailure(stderr: string): Error {
  // execFile rejects with an Error carrying `stderr` — `err()` prefers that over
  // `.message`, so the fixture has to have both to exercise the real branch.
  return Object.assign(new Error("Command failed: git"), { stderr });
}

// `redactCredentials` is left REAL (spread from the actual module): the forwarding path's
// contract is "git's words, minus the token", and mocking the redactor would test nothing.
vi.mock("@codegraph/vcs", async (importOriginal) => {
  const actual = await importOriginal<typeof VcsModule>();
  return {
    ...actual,
    isGitRepo: async () => true,
    getStatus: async () => {
      throw gitFailure(STATUS_STDERR);
    },
    push: async () => {
      throw gitFailure(PUSH_STDERR);
    },
  };
});
// Dynamic imports, not static: `vi.mock` and the CG_DATA_DIR assignment above must both
// take effect BEFORE @codegraph/persistence opens its database and before the route
// modules resolve @codegraph/vcs. Static imports hoist above both. Same pattern as
// trash-route-errors.test.ts.
const { db } = await import("@codegraph/persistence");
const { resetRateLimits } = await import("@/lib/rateLimit");
const { logger } = await import("@codegraph/observability");

// Public-bucket repo (owner_id IS NULL) with a resolvable workspace, so `requireWorkspace`
// admits an anonymous caller — which is precisely why the limiter cannot sit behind it.
const wsDir = path.join(dataDir, "workspaces", "repo-git");
mkdirSync(wsDir, { recursive: true });
db()
  .prepare(
    "INSERT INTO repos (id, url, name, source_type, status, workspace_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  .run("repo-git", "https://github.com/o/r", "o/r", "git", "done", wsDir, Date.now());

const { POST: reindexPOST } = await import("@/app/api/repos/[id]/reindex/route");
const { GET: gitGET, POST: gitPOST } = await import("@/app/api/repos/[id]/git/route");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => resetRateLimits());

const IP = "203.0.113.7";
const headers = { "x-forwarded-for": IP, "Content-Type": "application/json" };

describe("POST /api/repos/:id/reindex rate limit", () => {
  it("allows 6 calls per IP then answers 429 with Retry-After", async () => {
    // Deliberately an id that does NOT exist: the first six must get past the limiter and
    // be refused by the tenant/workspace gate, proving the limiter runs ahead of it. If it
    // were ordered the other way round the seventh would be a 404 too and cost nothing.
    const params = Promise.resolve({ id: "no-such-repo" });
    const call = () =>
      reindexPOST(new NextRequest("http://localhost/api/repos/no-such-repo/reindex", { method: "POST", headers }), {
        params,
      });

    for (let i = 0; i < 6; i++) {
      expect((await call()).status, `call ${i + 1} should be admitted`).not.toBe(429);
    }

    const res = await call();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await res.json()).error).toMatch(/too many/i);
  });

  it("buckets per IP — a different client is unaffected", async () => {
    const params = Promise.resolve({ id: "no-such-repo" });
    const url = "http://localhost/api/repos/no-such-repo/reindex";
    for (let i = 0; i < 7; i++) {
      await reindexPOST(new NextRequest(url, { method: "POST", headers }), { params });
    }
    const other = await reindexPOST(
      new NextRequest(url, { method: "POST", headers: { "x-forwarded-for": "198.51.100.9" } }),
      { params }
    );
    expect(other.status).not.toBe(429);
  });
});

describe("git route error disclosure", () => {
  const params = Promise.resolve({ id: "repo-git" });

  it("does not forward git stderr for a non-actionable op (status)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const res = await gitGET(new NextRequest("http://localhost/api/repos/repo-git/git?op=status", { headers }), {
      params,
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Git operation failed");
    expect(body.error).not.toContain(dataDir);
    // The detail is not destroyed, only moved server-side — an operator debugging this
    // still needs it, which is the whole reason `err` forwarded in the first place.
    expect(warn).toHaveBeenCalledWith("git route error", expect.objectContaining({ op: "status" }));
    expect(String(warn.mock.calls[0]?.[1]?.["error"])).toContain(dataDir);
    warn.mockRestore();
  });

  it("still forwards git's message for push, with the token redacted", async () => {
    const res = await gitPOST(
      new NextRequest("http://localhost/api/repos/repo-git/git", {
        method: "POST",
        headers,
        body: JSON.stringify({ op: "push" }),
      }),
      { params }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("non-fast-forward");
    expect(body.error).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});
