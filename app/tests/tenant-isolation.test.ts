import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { listRepos, getRepoOwnerId } from "@/lib/store";
import { repoAccessDenied, viewerId } from "@/lib/authz";
import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/session";
import type { SessionPayload } from "@/lib/session";

// Isolated data dir + session secret so this file never touches real data
// or another test file's environment.
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-tenant-"));
process.env.CG_DATA_DIR = dataDir;
process.env.CG_SESSION_SECRET = "test-secret-for-tenant-isolation";

const USER_A = 1001;
const USER_B = 2002;

function insertRepo(ownerId: number | null): string {
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO repos (id, url, name, source_type, status, owner_id, created_at) VALUES (?, ?, ?, 'git', 'done', ?, ?)"
    )
    .run(id, `https://github.com/x/${id}`, id, ownerId, Date.now());
  return id;
}

function requestAs(userId: number | null): NextRequest {
  const headers = new Headers();
  if (userId !== null) {
    const payload: SessionPayload = {
      userId,
      login: `user-${userId}`,
      name: null,
      avatarUrl: "",
      accessToken: "unused",
      issuedAt: Date.now(),
    };
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${encryptSession(payload)}`);
  }
  return new NextRequest("http://localhost/api/repos/x", { headers });
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("listRepos tenant scoping", () => {
  let publicRepo: string;
  let privateA: string;
  let privateB: string;

  beforeAll(() => {
    publicRepo = insertRepo(null);
    privateA = insertRepo(USER_A);
    privateB = insertRepo(USER_B);
  });

  it("shows an anonymous viewer only the public bucket", () => {
    const ids = listRepos(null).map((r) => r.id);
    expect(ids).toContain(publicRepo);
    expect(ids).not.toContain(privateA);
    expect(ids).not.toContain(privateB);
  });

  it("shows user A their own private repo plus the public bucket, never user B's", () => {
    const ids = listRepos(USER_A).map((r) => r.id);
    expect(ids).toContain(publicRepo);
    expect(ids).toContain(privateA);
    expect(ids).not.toContain(privateB);
  });

  it("shows user B their own private repo plus the public bucket, never user A's", () => {
    const ids = listRepos(USER_B).map((r) => r.id);
    expect(ids).toContain(publicRepo);
    expect(ids).toContain(privateB);
    expect(ids).not.toContain(privateA);
  });
});

describe("getRepoOwnerId", () => {
  it("returns undefined for a repo that doesn't exist", () => {
    expect(getRepoOwnerId(randomUUID())).toBeUndefined();
  });

  it("returns null for a public-bucket repo", () => {
    const id = insertRepo(null);
    expect(getRepoOwnerId(id)).toBeNull();
  });

  it("returns the owning userId for a privately-owned repo", () => {
    const id = insertRepo(USER_A);
    expect(getRepoOwnerId(id)).toBe(USER_A);
  });
});

describe("repoAccessDenied — the cross-account leak this suite guards against", () => {
  it("denies access to a repo that doesn't exist, for anyone", () => {
    const missing = randomUUID();
    expect(repoAccessDenied(requestAs(null), missing)?.status).toBe(404);
    expect(repoAccessDenied(requestAs(USER_A), missing)?.status).toBe(404);
  });

  it("allows anyone — signed out or any account — into the public bucket", () => {
    const id = insertRepo(null);
    expect(repoAccessDenied(requestAs(null), id)).toBeNull();
    expect(repoAccessDenied(requestAs(USER_A), id)).toBeNull();
    expect(repoAccessDenied(requestAs(USER_B), id)).toBeNull();
  });

  it("allows the owner into their own private repo", () => {
    const id = insertRepo(USER_A);
    expect(repoAccessDenied(requestAs(USER_A), id)).toBeNull();
  });

  it("denies a signed-out visitor access to someone else's private repo", () => {
    const id = insertRepo(USER_A);
    expect(repoAccessDenied(requestAs(null), id)?.status).toBe(404);
  });

  it("denies a DIFFERENT signed-in account access to another account's private repo", () => {
    const id = insertRepo(USER_A);
    const denied = repoAccessDenied(requestAs(USER_B), id);
    expect(denied?.status).toBe(404);
  });

  it("never leaks a private repo's existence: denial looks identical to not-found", async () => {
    const missing = randomUUID();
    const owned = insertRepo(USER_A);
    const missingBody = await repoAccessDenied(requestAs(USER_B), missing)?.json();
    const ownedBody = await repoAccessDenied(requestAs(USER_B), owned)?.json();
    expect(missingBody).toEqual(ownedBody);
  });
});

describe("viewerId", () => {
  it("is null for a signed-out request", () => {
    expect(viewerId(requestAs(null))).toBeNull();
  });

  it("reflects the session's userId when signed in", () => {
    expect(viewerId(requestAs(USER_A))).toBe(USER_A);
  });
});
