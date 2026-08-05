import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openConnection } from "../src/db";
import type { SqliteDatabase, SqliteDatabaseConstructor } from "../src/sqlite";

/**
 * What happens to the handle when `openConnection` fails partway.
 *
 * Everything after the constructor can throw — a truncated or non-SQLite file at the first
 * pragma, ENOSPC or EACCES on the WAL conversion, the explicit 5 s WAL deadline, any
 * migration. The handle was a local that only reached `g.__cgDb` on success, so a throw
 * dropped it unreferenced; node:sqlite frees a `DatabaseSync` on `close()` and not on GC, so
 * every failed `db()` leaked an fd, a page cache and an shm mapping. `db()` is called per
 * request and /api/health never touches the database, so the container kept reporting healthy
 * while walking into an OOM on 512 MB.
 *
 * The constructor is injected rather than the module mocked: the code under test is the real
 * `openConnection`, running its real pragma sequence and its real migration call, and only
 * the handle it operates on is a stand-in — which is the only way to observe `close()` at all,
 * since node:sqlite exposes no "am I open" predicate.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-open-"));
  dirs.push(dir);
  return dir;
}

/**
 * A handle that fails on the first statement matching `failOn` and counts its own closes.
 *
 * `prepare().get()` reports WAL so the retry loop in `openConnection` exits immediately, and
 * returns a truthy row for the migration runner's "already recorded?" probe so every migration
 * is skipped. Both keep the success path fast and side-effect free; the failure injection is
 * the only thing under test.
 */
function fakeSqlite(failOn: RegExp | null): {
  Ctor: SqliteDatabaseConstructor;
  closes: () => number;
  statements: () => string[];
} {
  let closes = 0;
  const statements: string[] = [];

  class FakeDatabase implements SqliteDatabase {
    exec(sql: string): void {
      statements.push(sql);
      if (failOn?.test(sql)) throw new Error("SQLITE_IOERR: disk I/O error");
    }
    prepare(sql: string) {
      statements.push(sql);
      if (failOn?.test(sql)) throw new Error("SQLITE_IOERR: disk I/O error");
      return {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => ({ journal_mode: "wal" }),
        all: () => [],
      };
    }
    close(): void {
      closes++;
    }
  }

  return {
    Ctor: FakeDatabase as unknown as SqliteDatabaseConstructor,
    closes: () => closes,
    statements: () => statements,
  };
}

describe("openConnection", () => {
  it("closes the handle when a pragma fails", () => {
    // busy_timeout is the first statement issued, and the first place a file that is not a
    // database announces itself.
    const fake = fakeSqlite(/busy_timeout/);
    expect(() => openConnection(freshDir(), fake.Ctor)).toThrow(/disk I\/O error/);
    expect(fake.closes()).toBe(1);
  });

  it("closes the handle when the migrations fail", () => {
    // The late failure matters as much as the early one: by this point the connection has a
    // WAL and an shm mapping attached, which is the expensive half of the leak.
    const fake = fakeSqlite(/schema_migrations/);
    expect(() => openConnection(freshDir(), fake.Ctor)).toThrow(/disk I\/O error/);
    expect(fake.closes()).toBe(1);
    // And it got far enough to be the migration step, not an earlier accident.
    expect(fake.statements().some((s) => s.includes("PRAGMA foreign_keys"))).toBe(true);
  });

  it("propagates the original failure rather than a close error", () => {
    const fake = fakeSqlite(/foreign_keys/);
    // A `close()` that throws must not replace the reason the open failed — the same
    // substitution `recordRun`'s unconditional ROLLBACK used to make.
    const Throwing = class extends (fake.Ctor as unknown as { new (p: string): SqliteDatabase }) {
      override close(): void {
        throw new Error("close failed too");
      }
    } as unknown as SqliteDatabaseConstructor;
    expect(() => openConnection(freshDir(), Throwing)).toThrow(/disk I\/O error/);
  });

  it("leaves a successfully opened handle open", () => {
    // The guard must not close on the way out of the happy path, which would make every
    // request open and immediately discard a connection.
    const fake = fakeSqlite(null);
    expect(openConnection(freshDir(), fake.Ctor)).toBeTruthy();
    expect(fake.closes()).toBe(0);
  });
});
