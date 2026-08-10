import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { db } from "@codegraph/persistence";
import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/session";
import type { SessionPayload } from "@/lib/session";
import { GET as fleetGet } from "@/app/api/fleet/route";
import type { FleetGraph } from "@/lib/types";

// Isolated data dir + session secret so this file never touches real data or
// another test file's environment. Config reads `process.env` lazily, so
// assigning here — after the hoisted imports — is in time.
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-fleet-"));
process.env.CG_DATA_DIR = dataDir;
process.env.CG_SESSION_SECRET = "test-secret-for-fleet-graph";

const USER_A = 3003;
const USER_B = 4004;

interface Seed {
  readonly name: string;
  readonly status: string;
  readonly ownerId: number | null;
  readonly createdAt: number;
  /** Raw `deps` column, exactly as stored — including deliberately bad blobs. */
  readonly deps: string;
  /** Raw `package_names_json`: the names this repo's own manifests DECLARE. */
  readonly packageNames?: string;
}

/**
 * The whole fixture, seeded through the real persistence layer.
 *
 * `created_at` is explicit and descending because the route's name→id lookup
 * documents a first-row-wins tie-break, and a test that depends on insertion
 * timing would not be testing that.
 */
const SEEDS: readonly Seed[] = [
  // Still indexing: must not appear at all.
  { name: "acme/pending", status: "queued", ownerId: null, createdAt: 100, deps: "[]" },
  {
    name: "acme/web",
    status: "done",
    ownerId: null,
    createdAt: 90,
    // In order: a full-name hit, a bare-segment hit, the SAME bare-segment hit
    // again, a self-reference by full name, a self-reference by bare segment,
    // an exact-name hit that a bare segment also claims, a package nobody in
    // the fleet provides, and another account's private repo.
    deps: JSON.stringify([
      "acme/api",
      "ui-kit",
      "ui-kit",
      "acme/web",
      "web",
      "logger",
      "left-pad",
      "secret",
    ]),
  },
  // Newer than the bare `logger` repo, so a single-pass lookup would let its
  // bare segment win the key "logger". Exact names must win instead.
  { name: "tools/logger", status: "done", ownerId: null, createdAt: 80, deps: "[]" },
  { name: "acme/api", status: "done", ownerId: null, createdAt: 70, deps: JSON.stringify(["ui-kit", "@acme/toolkit"]) },
  { name: "acme/ui-kit", status: "done", ownerId: null, createdAt: 60, deps: "[]" },
  { name: "logger", status: "done", ownerId: null, createdAt: 50, deps: "[]" },
  // Not JSON at all.
  { name: "acme/corrupt", status: "done", ownerId: null, createdAt: 40, deps: "{not valid json" },
  // Valid JSON, wrong shape — the case a bare try/catch would still let through.
  {
    name: "acme/not-an-array",
    status: "done",
    ownerId: null,
    createdAt: 30,
    deps: JSON.stringify({ express: "^4.0.0" }),
  },
  { name: "acme/secret", status: "done", ownerId: USER_B, createdAt: 20, deps: JSON.stringify(["ui-kit"]) },
  /*
   * The case a display-name lookup can never resolve, and the reason the real fleet graph
   * reported 12 repositories and 0 edges: a repository whose DISPLAY name is nothing like the
   * package it PUBLISHES. `acme/api` below declares `@acme/toolkit`, which only `platform`
   * provides, and only `platform`'s manifest says so.
   */
  { name: "platform", status: "done", ownerId: null, createdAt: 10, deps: "[]", packageNames: JSON.stringify(["@acme/toolkit"]) },
];

const ids = new Map<string, string>();
const id = (name: string): string => {
  const value = ids.get(name);
  if (value === undefined) throw new Error(`fixture has no repo named ${name}`);
  return value;
};

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
  return new NextRequest("http://localhost/api/fleet", { headers });
}

async function fleetFor(userId: number | null): Promise<FleetGraph> {
  const res = await fleetGet(requestAs(userId));
  expect(res.status).toBe(200);
  return (await res.json()) as FleetGraph;
}

const names = (graph: FleetGraph): string[] => graph.nodes.map((n) => n.name).sort();
const edgePairs = (graph: FleetGraph): string[] =>
  graph.edges.map((e) => `${e.source}->${e.target}`).sort();

beforeAll(() => {
  for (const seed of SEEDS) {
    const repoId = `repo-${seed.name.replace(/\W+/g, "-")}`;
    ids.set(seed.name, repoId);
    db()
      .prepare(
        `INSERT INTO repos (id, url, name, source_type, status, score, loc, deps, package_names_json, owner_id, created_at)
         VALUES (?, ?, ?, 'git', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repoId,
        `https://github.com/${seed.name}`,
        seed.name,
        seed.status,
        seed.createdAt,
        seed.createdAt * 10,
        seed.deps,
        seed.packageNames ?? null,
        seed.ownerId,
        seed.createdAt,
      );
  }
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/fleet — nodes", () => {
  it("returns every finished repo in the public bucket, and nothing still indexing", async () => {
    const graph = await fleetFor(null);
    expect(names(graph)).toEqual([
      "acme/api",
      "acme/corrupt",
      "acme/not-an-array",
      "acme/ui-kit",
      "acme/web",
      "logger",
      "platform",
      "tools/logger",
    ]);
  });

  it("carries the fields the graph draws with, straight from the row", async () => {
    const graph = await fleetFor(null);
    const web = graph.nodes.find((n) => n.name === "acme/web");
    expect(web).toEqual({
      id: id("acme/web"),
      name: "acme/web",
      url: "https://github.com/acme/web",
      score: 90,
      sourceType: "git",
      loc: 900,
      // The fixture writes repo rows but no `runs`, so there is nothing to compare against
      // and nothing failed. Null, not a zeroed drift: "never indexed twice" and "indexed
      // twice and unchanged" must not render as the same thing.
      drift: null,
      // False, not absent: the dashboard marks a score computed over a capped sample, and
      // "not capped" has to be a stated fact rather than a missing field.
      capHit: false,
    });
  });
});

describe("GET /api/fleet — edges", () => {
  it("links a repo to the repos its dependencies name", async () => {
    const graph = await fleetFor(null);
    expect(edgePairs(graph)).toEqual(
      [
        `${id("acme/web")}->${id("acme/api")}`,
        `${id("acme/web")}->${id("acme/ui-kit")}`,
        `${id("acme/web")}->${id("logger")}`,
        `${id("acme/api")}->${id("acme/ui-kit")}`,
        // Resolved through `platform`'s DECLARED package name, not its display name.
        `${id("acme/api")}->${id("platform")}`,
      ].sort(),
    );
  });

  it("links a repo to one whose manifest publishes the package, not one whose name matches", async () => {
    /*
     * The bug this pins. `platform` is displayed as `platform` and publishes `@acme/toolkit`;
     * `acme/api` depends on `@acme/toolkit`. Keying the lookup on display names finds nothing,
     * which is exactly what the live fleet graph did: 12 repositories, 0 edges, under a
     * heading promising "dependency edges between indexed repositories".
     */
    const graph = await fleetFor(null);
    expect(edgePairs(graph)).toContain(`${id("acme/api")}->${id("platform")}`);
  });

  it("emits no self-edges, however the repo names itself", async () => {
    const graph = await fleetFor(null);
    expect(graph.edges.filter((e) => e.source === e.target)).toEqual([]);
  });

  it("emits a duplicated dependency once", async () => {
    const graph = await fleetFor(null);
    expect(edgePairs(graph)).toEqual([...new Set(edgePairs(graph))]);
  });

  it("prefers an exact repo name over another repo's bare segment", async () => {
    const graph = await fleetFor(null);
    // `logger` and `tools/logger` both answer to the dependency name "logger";
    // the exact match wins even though `tools/logger` sorts first.
    expect(graph.edges).toContainEqual({ source: id("acme/web"), target: id("logger") });
    expect(graph.edges).not.toContainEqual({ source: id("acme/web"), target: id("tools/logger") });
  });

  it("is deterministic across repeated requests", async () => {
    const first = await fleetFor(null);
    const second = await fleetFor(null);
    expect(second).toEqual(first);
  });
});

describe("GET /api/fleet — corrupt dependency blobs", () => {
  it("does not throw, and keeps every other repo's edges", async () => {
    const graph = await fleetFor(null);
    // Both bad rows are still nodes; they simply contribute no edges.
    expect(names(graph)).toContain("acme/corrupt");
    expect(names(graph)).toContain("acme/not-an-array");
    const bad = new Set([id("acme/corrupt"), id("acme/not-an-array")]);
    expect(graph.edges.filter((e) => bad.has(e.source))).toEqual([]);
    expect(graph.edges).toHaveLength(5);
  });
});

describe("GET /api/fleet — tenant isolation", () => {
  it("never shows another account's private repo, as a node or an edge target", async () => {
    for (const viewer of [null, USER_A]) {
      const graph = await fleetFor(viewer);
      expect(names(graph)).not.toContain("acme/secret");
      const secretId = id("acme/secret");
      expect(graph.edges.some((e) => e.source === secretId || e.target === secretId)).toBe(false);
    }
  });

  it("shows the owner their own private repo, wired into the graph", async () => {
    const graph = await fleetFor(USER_B);
    expect(names(graph)).toContain("acme/secret");
    expect(graph.edges).toContainEqual({ source: id("acme/web"), target: id("acme/secret") });
    expect(graph.edges).toContainEqual({ source: id("acme/secret"), target: id("acme/ui-kit") });
  });
});

describe("GET /api/fleet — cost", () => {
  const statementsFor = async (viewer: number | null): Promise<string[]> => {
    const database = db();
    const realPrepare = database.prepare.bind(database);
    const statements: string[] = [];
    database.prepare = (sql: string) => {
      statements.push(sql);
      return realPrepare(sql);
    };
    try {
      await fleetFor(viewer);
    } finally {
      database.prepare = realPrepare;
    }
    return statements;
  };

  /**
   * The invariant is CONSTANT statements, not one — what REVIEW B7 removed was an N+1, and
   * a fixed second query that batches every repo id into one `IN (...)` is not one. Asserting
   * the literal number instead would have to be edited by whoever adds the next batched
   * lookup, which teaches them to raise the number rather than to check the shape.
   *
   * Measured against two viewers who see DIFFERENT repo counts: the anonymous bucket and the
   * account that also sees a private repo. Same statement count, more rows.
   */
  it("issues a fixed number of statements, whatever the repo count", async () => {
    const anonymous = await statementsFor(null);
    const owner = await statementsFor(USER_B);

    expect(owner.length).toBe(anonymous.length);
    /*
     * Three: the repo listing, the batched run-delta lookup that feeds `drift`, and the
     * batched cap-hit lookup that marks a repository whose score is a sample. Raising this
     * number is only legitimate when the new statement is BATCHED, which the equality above
     * is what actually proves - two viewers seeing different repo counts must still issue the
     * same number of statements. The literal is a tripwire for an unreviewed addition.
     */
    expect(anonymous).toHaveLength(3);
    // Neither may reach for the heavy blobs.
    for (const sql of anonymous) {
      for (const column of ["symbols", "viz", "tree", "modules", "graph", "issues", "*"]) {
        expect(sql).not.toContain(column);
      }
    }
  });
});
