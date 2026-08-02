import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-trash-route-"));
process.env["CG_DATA_DIR"] = dataDir;

/**
 * The trash route echoed `e.message` straight back to the client, while the fs route beside
 * it — doing the same filesystem work on the same workspace — logs the raw error and returns
 * a generic one. Every trash operation is a move or an unlink, so a raw `ENOENT`/`EEXIST`
 * from node:fs was the common failure, and those messages embed the server's ABSOLUTE
 * workspace path. That is F023 (internal path disclosure) on a route any repo viewer can hit.
 *
 * `@/lib/trash` is mocked because the thing under test is the route's error POLICY, not the
 * trash logic: what must hold is that an arbitrary raw error never reaches the client, and
 * the only way to assert "arbitrary" is to throw one.
 */
const LEAKY = `ENOENT: no such file or directory, rename '${dataDir}/workspaces/secret-repo/a' -> '${dataDir}/trash/b'`;

vi.mock("@/lib/trash", () => ({
  listTrash: () => {
    throw new Error(LEAKY);
  },
  restoreFromTrash: () => {
    throw new Error(LEAKY);
  },
  purgeTrashEntry: () => {
    throw new Error(LEAKY);
  },
  emptyTrash: () => {
    throw new Error(LEAKY);
  },
}));

const { db } = await import("@codegraph/persistence");
// A public-bucket repo (no owner), so `repoAccessDenied` lets the request through to the
// handler — the error policy under test only runs after the tenant check passes.
db()
  .prepare("INSERT INTO repos (id, url, name, source_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run("repo-1", "https://example.com/o/r", "o/r", "git", "done", Date.now());

const { GET, POST } = await import("@/app/api/repos/[id]/trash/route");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const params = Promise.resolve({ id: "repo-1" });

describe("trash route error disclosure", () => {
  it("does not return a raw filesystem error from GET", async () => {
    const res = await GET(new NextRequest("http://localhost/api/repos/repo-1/trash"), { params });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain(dataDir);
    expect(body.error).not.toContain("ENOENT");
    expect(body.error).toBe("Trash operation failed");
  });

  it.each(["purge", "empty"])("does not return a raw filesystem error from POST %s", async (op) => {
    const req = new NextRequest("http://localhost/api/repos/repo-1/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, trashId: "t-1" }),
    });
    const res = await POST(req, { params });
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain(dataDir);
    expect(body.error).not.toContain("rename");
    expect(body.error).toBe("Trash operation failed");
  });
});
