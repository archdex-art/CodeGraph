import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

// Isolated data dir + session secret, set BEFORE importing anything that
// touches the DB or session crypto.
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-publish-"));
process.env.CG_DATA_DIR = dataDir;
process.env.CG_SESSION_SECRET = "test-secret-for-publish-credential";

const { db } = await import("@codegraph/persistence");
const { publishCredential, repoAccessDenied } = await import("@/lib/authz");
const { encryptSession, SESSION_COOKIE_NAME } = await import("@/lib/session");
type SessionPayload = import("@/lib/session").SessionPayload;

const USER_A = 4001;
const USER_B = 5002;
const TOKEN_A = "gho_token_for_user_a";
const TOKEN_B = "gho_token_for_user_b";

function upsertRepo(ownerId: number | null): string {
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO repos (id, url, name, source_type, status, owner_id, created_at) VALUES (?, ?, ?, 'git', 'done', ?, ?)",
    )
    .run(id, `https://github.com/x/${id}`, id, ownerId, Date.now());
  return id;
}

function requestAs(userId: number | null, accessToken = "unused", extraHeaders: Record<string, string> = {}): NextRequest {
  const headers = new Headers(extraHeaders);
  if (userId !== null) {
    const payload: SessionPayload = {
      userId,
      login: `user-${userId}`,
      name: null,
      avatarUrl: "",
      accessToken,
      issuedAt: Date.now(),
    };
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${encryptSession(payload)}`);
  }
  return new NextRequest("http://localhost/api/repos/x/fix", { method: "POST", headers });
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("publishCredential", () => {
  let publicRepo: string;
  let ownedByA: string;
  let ownedByB: string;

  beforeAll(() => {
    publicRepo = upsertRepo(null);
    ownedByA = upsertRepo(USER_A);
    ownedByB = upsertRepo(USER_B);
  });

  it("gives the owner their own session token", () => {
    expect(publishCredential(requestAs(USER_A, TOKEN_A), ownedByA)).toBe(TOKEN_A);
  });

  it("gives an anonymous caller nothing, even on a public-bucket repo", () => {
    expect(publishCredential(requestAs(null), publicRepo)).toBeUndefined();
  });

  // The core regression. A signed-in visitor can READ and fix a public-bucket
  // repo (repoAccessDenied allows it), but that repo was indexed anonymously
  // and they never claimed it — so we must not push to its remote for them.
  it("withholds the token on a public-bucket repo the viewer does not own", () => {
    const req = requestAs(USER_A, TOKEN_A);
    expect(repoAccessDenied(req, publicRepo)).toBeNull(); // read access: allowed
    expect(publishCredential(req, publicRepo)).toBeUndefined(); // publish: denied
  });

  it("withholds the token when a signed-in viewer targets someone else's repo", () => {
    expect(publishCredential(requestAs(USER_A, TOKEN_A), ownedByB)).toBeUndefined();
  });

  it("never hands user A's token to user B", () => {
    expect(publishCredential(requestAs(USER_B, TOKEN_B), ownedByA)).toBeUndefined();
  });

  it("returns undefined for a repo that does not exist", () => {
    expect(publishCredential(requestAs(USER_A, TOKEN_A), randomUUID())).toBeUndefined();
  });

  // The specific defect this replaced: `executeFixes(repo, body.githubToken)`.
  // A token supplied by the caller must have no effect on the credential used.
  it("ignores a token supplied via headers or body-shaped input", () => {
    const req = requestAs(null, "unused", {
      "x-github-token": "gho_attacker_supplied",
      authorization: "Bearer gho_attacker_supplied",
    });
    expect(publishCredential(req, publicRepo)).toBeUndefined();
    expect(publishCredential(req, ownedByA)).toBeUndefined();
  });

  it("ignores a forged session cookie signed with the wrong secret", () => {
    const headers = new Headers();
    headers.set(SESSION_COOKIE_NAME, "not-a-valid-encrypted-session");
    headers.set("cookie", `${SESSION_COOKIE_NAME}=not-a-valid-encrypted-session`);
    const req = new NextRequest("http://localhost/api/repos/x/fix", { headers });
    expect(publishCredential(req, ownedByA)).toBeUndefined();
  });
});
