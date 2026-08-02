import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The shipped image runs two processes against ONE SQLite file — the web tier and
 * `apps/worker` — and `db()` opens lazily, so first contact with the database is a
 * genuine race on every cold start. None of it is reachable from a single-process
 * test: `DatabaseSync` is synchronous, so within one process the operations that
 * race are already serialised. These tests therefore spawn real child processes.
 *
 * Each child does exactly what a booting process does: open the database (which
 * runs the pragmas and the migrations) and enqueue a job with the same idempotency
 * key a double-submitted POST would carry.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDataDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "cg-race-"));
  dirs.push(d);
  return d;
}

/**
 * Boot the persistence layer in a child process and enqueue one job.
 *
 * `await import` of a literal path rather than a static import: this is source for a
 * child `node -e` script, not a module the bundler or type checker can see, and
 * `--input-type=module` has no file to resolve relative specifiers against.
 *
 * The children busy-wait on a shared wall-clock instant before touching the database.
 * Without it, process startup jitter (tsx compiles the whole import graph) staggers
 * them by hundreds of milliseconds and the window the bugs live in never opens.
 */
const CHILD = `
  const startAt = Number(process.argv[2]);
  const { enqueueJob } = await import(${JSON.stringify(path.join(here, "../src/index.ts"))});
  while (Date.now() < startAt) { /* spin to the barrier */ }
  const r = enqueueJob({
    id: "job-" + process.argv[1],
    repoId: "repo-1",
    kind: "analyze",
    payload: {},
    idempotencyKey: "same-key",
  });
  console.log(JSON.stringify(r));
`;

function raceChildren(count: number, dataDir: string) {
  const startAt = Date.now() + 1_500; // barrier: past the slowest child's tsx startup
  const results = Array.from({ length: count }, (_, i) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", CHILD, "--", String(i), String(startAt)],
        {
          cwd: repoRoot,
          env: { ...process.env, CG_DATA_DIR: dataDir },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    })
  );
  return Promise.all(results);
}

describe("concurrent processes against one database file", () => {
  it("all boot successfully and the idempotency key admits exactly one job", async () => {
    // Three bugs converge on this one scenario, and every one of them was an
    // unhandled throw that killed a booting process:
    //  1. `PRAGMA journal_mode = WAL` needs an exclusive lock and does NOT invoke
    //     the busy handler, so on a cold, rollback-mode file the loser died with
    //     "database is locked". busy_timeout was also set AFTER it, so no busy
    //     handler was even installed yet.
    //  2. `runMigrations` computed its pending list outside the write lock, so both
    //     processes applied the same migration and the loser hit
    //     "UNIQUE constraint failed: schema_migrations.version".
    //  3. `enqueueJob` did SELECT-then-INSERT, so the loser of that race hit
    //     "UNIQUE constraint failed: jobs.idempotency_key" — a 500 for exactly the
    //     double-submitted POST the key exists to make harmless.
    const dataDir = freshDataDir();
    const results = await raceChildren(6, dataDir);

    const failures = results.filter((r) => r.code !== 0);
    expect(
      failures.map((f) => f.err.split("\n").find((l) => l.includes("Error")) ?? f.err.slice(0, 200))
    ).toEqual([]);

    // Exactly one insert won; every other child reported the winner's id.
    const parsed = results.map((r) => JSON.parse(r.out.trim()) as { id: string; deduplicated: boolean });
    expect(parsed.filter((p) => !p.deduplicated)).toHaveLength(1);
    const winner = parsed.find((p) => !p.deduplicated)!.id;
    for (const p of parsed) expect(p.id).toBe(winner);
  }, 120_000);
});
