import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "@codegraph/persistence";
import { hasSnapshot, isCommitHash, loadSnapshotCache } from "@/lib/gitops/timelineStore";
import { loadSnapshot } from "@/lib/gitops/snapshotLoader";

/**
 * `GET /api/repos/:id/timeline?op=snapshot&hash=…` puts a query parameter straight into a
 * filesystem path (`data/timeline/<repoId>/<hash>.json`) and into `git archive`'s argv.
 * Unvalidated, `hash=../<other-repo-id>/<commit>` read another tenant's cached architecture
 * graph — the repo guard on `:id` checks the repo the CALLER named, not the directory the
 * hash then walked into.
 */
describe("timeline snapshot hashes", () => {
  it("accepts real git object names and rejects everything else", () => {
    expect(isCommitHash("9f8c1c0")).toBe(true);
    expect(isCommitHash("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isCommitHash("../victim/0123456")).toBe(false);
    expect(isCommitHash("../../../../etc/hosts")).toBe(false);
    expect(isCommitHash("--output=/app/data/x")).toBe(false);
    expect(isCommitHash("HEAD")).toBe(false);
    expect(isCommitHash("")).toBe(false);
  });

  it("refuses to read another repo's cached snapshot through a traversing hash", async () => {
    const victim = path.join(dataDir(), "timeline", "victim-repo");
    mkdirSync(victim, { recursive: true });
    const commit = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(path.join(victim, `${commit}.json`), JSON.stringify({ secret: true }), "utf8");

    const traversal = `../victim-repo/${commit}`;
    expect(() => hasSnapshot("attacker-repo", traversal)).toThrow(/Invalid commit hash/);
    await expect(loadSnapshotCache("attacker-repo", traversal)).rejects.toThrow(/Invalid commit hash/);

    // The victim's own read still works — the guard is on the shape, not on the feature.
    expect(hasSnapshot("victim-repo", commit)).toBe(true);
  });

  it("refuses a non-hash before it reaches git archive's argv", async () => {
    await expect(loadSnapshot(process.cwd(), "--output=/tmp/cg-should-not-exist")).rejects.toThrow(
      /Invalid commit hash/
    );
    expect(existsSync("/tmp/cg-should-not-exist")).toBe(false);
  });
});
