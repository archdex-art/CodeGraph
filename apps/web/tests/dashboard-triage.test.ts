import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { triage } from "@/app/dashboard/page";
import type { RepoSummary } from "@/lib/types";

/**
 * What the dashboard puts first.
 *
 * WHY THIS IS A TEST
 *
 * The list is headed "Ranked by where attention is needed", and it led with three FAILED
 * repositories — a typo'd URL from the previous day among them — because a failed row has no
 * score and the risk order sorted the absence of a score to the top. Measured on a real
 * dashboard: 4 of 19 rows were dead entries outranking the other 15, so the primary
 * return-visit surface opened on garbage.
 *
 * The reasoning that put them there was not wrong about IN-FLIGHT rows: an index still running
 * genuinely is the most urgent thing on the page. It was wrong to treat "never finished" and
 * "finished by failing yesterday" as the same state. These tests pin that distinction, because
 * it is a judgement about what a reader sees first and it can regress silently.
 */
const repo = (over: Partial<RepoSummary>): RepoSummary =>
  ({
    id: "r", name: "n", url: "https://example.com/n", sourceType: "git",
    status: "done", score: 90, createdAt: 1_000, finishedAt: 2_000, hasWorkspace: true,
    ...over,
  }) as RepoSummary;

describe("dashboard triage", () => {
  it("keeps failed repositories out of the ranked list entirely", () => {
    const { live, failed } = triage(
      [repo({ id: "ok", score: 90 }), repo({ id: "bad", status: "error", score: null })],
      "risk",
    );
    expect(live.map((r) => r.id)).toEqual(["ok"]);
    expect(failed.map((r) => r.id)).toEqual(["bad"]);
  });

  it("does not let a failed row outrank the worst real repository", () => {
    // The exact regression, in miniature: the failure has no score, the real repo scores 61,
    // and the reader must see the 61 first.
    const { live } = triage(
      [
        repo({ id: "failed-yesterday", status: "error", score: null, finishedAt: 9_999 }),
        repo({ id: "worst-real", score: 61 }),
        repo({ id: "healthy", score: 98 }),
      ],
      "risk",
    );
    expect(live.map((r) => r.id)).toEqual(["worst-real", "healthy"]);
  });

  it("still floats an in-flight index to the top", () => {
    /*
     * The half of the original reasoning that was right, and must survive. A run in progress
     * has no score for the same reason a failed one does not, but it IS the most urgent row —
     * something is happening and the reader is probably waiting for it.
     */
    const { live } = triage(
      [repo({ id: "done-low", score: 20 }), repo({ id: "running", status: "indexing", score: null })],
      "risk",
    );
    expect(live[0]!.id).toBe("running");
  });

  it("orders failures newest first, whatever the list order", () => {
    // No risk to rank; the one just attempted is the one still being thought about.
    const rows = [
      repo({ id: "old", status: "error", score: null, finishedAt: 1 }),
      repo({ id: "new", status: "error", score: null, finishedAt: 500 }),
    ];
    for (const order of ["risk", "recent"] as const) {
      expect(triage(rows, order).failed.map((r) => r.id)).toEqual(["new", "old"]);
    }
  });

  it("honours recency order for the live list without readmitting failures", () => {
    const { live, failed } = triage(
      [
        repo({ id: "older", score: 10, finishedAt: 1 }),
        repo({ id: "newer", score: 99, finishedAt: 900 }),
        repo({ id: "bad", status: "error", score: null }),
      ],
      "recent",
    );
    expect(live.map((r) => r.id)).toEqual(["newer", "older"]);
    expect(failed).toHaveLength(1);
  });

  it("survives a null list, which is what the page renders before its first fetch", () => {
    expect(triage(null, "risk")).toEqual({ live: [], failed: [] });
  });
});

/**
 * Retry has to retire the row it supersedes.
 *
 * Source-level, matching this repo's convention for UI claims: the handler calls two endpoints
 * and the property is about which, not about rendering. Found by running it — the first version
 * re-submitted the URL and left the failed row in place, and `/api/index` does not reuse it, so
 * every retry added a duplicate. A control added to clear clutter became a source of it.
 */
describe("retry supersedes rather than duplicates", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../src/app/dashboard/page.tsx"),
    "utf8",
  );
  const handler = src.slice(src.indexOf("async function handleRetry"), src.indexOf("useEffect("));

  it("deletes the old row after starting the new index", () => {
    expect(handler).toMatch(/startIndex\(/);
    expect(handler).toMatch(/deleteRepo\(repo\.id\)/);
  });

  it("only deletes when the new job got a different id", () => {
    // Guard, not decoration: if `/api/index` ever starts reusing the row, an unconditional
    // delete would destroy the job the retry just started.
    expect(handler).toMatch(/repoId !== repo\.id/);
  });

  it("does not reach for re-index, which refuses a repo that never cloned", () => {
    // Verified against the running server: 404 "Workspace not ready".
    expect(handler).not.toMatch(/reindex/i);
  });
});
