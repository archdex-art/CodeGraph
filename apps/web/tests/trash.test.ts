import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Isolated data dir so this file never touches real data or another test
// file's environment (same convention as db.test.ts / tenant-isolation.test.ts).
const dataDir = mkdtempSync(path.join(tmpdir(), "cg-trash-"));
process.env.CG_DATA_DIR = dataDir;

import { moveToTrash, listTrash } from "@/lib/trash";

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("moveToTrash size accounting is symlink-safe", () => {
  it("does not follow a recursive symlink into infinite recursion when sizing a trashed dir", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "cg-trash-ws-"));
    try {
      // A directory containing a real file plus a symlink pointing back at its
      // own parent — statSync-based recursion would loop until stack overflow.
      const target = path.join(ws, "docs");
      mkdirSync(target);
      writeFileSync(path.join(target, "readme.txt"), "hello", "utf8");
      symlinkSync(target, path.join(target, "loop"), "dir");

      const repoId = randomUUID();
      // Must complete (no RangeError: Maximum call stack size exceeded) and
      // report a finite size covering the real file but not the symlink target.
      const entry = moveToTrash(repoId, ws, "docs");
      expect(entry.type).toBe("dir");
      expect(entry.size).toBe(5); // "hello" — symlink contributes 0, not an infinite walk
      expect(listTrash(repoId).map((e) => e.name)).toContain("docs");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
