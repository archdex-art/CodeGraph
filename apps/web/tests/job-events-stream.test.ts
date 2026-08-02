import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

const dataDir = mkdtempSync(path.join(tmpdir(), "cg-sse-"));
process.env["CG_DATA_DIR"] = dataDir;

const { db } = await import("@codegraph/persistence");
const { GET } = await import("@/app/api/jobs/[id]/events/route");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
  db().exec("DELETE FROM jobs");
  db().exec("DELETE FROM repos");
});

/**
 * The SSE progress stream, exercised through the real route against a real database.
 *
 * The bug this covers is only reachable on the ALREADY-FINISHED path: `finish()` was
 * called before `const timer = setInterval(...)` had been evaluated, so `clearInterval`
 * hit the temporal dead zone and threw inside `start()`. A client attaching to a job that
 * had just completed — the normal outcome of a fast index, and of every reconnect — got a
 * broken stream instead of its terminal `end` event. The still-running path never touched
 * it, which is why nothing noticed.
 */
function seedJob(status: "queued" | "done" | "error"): string {
  const now = Date.now();
  db()
    .prepare("INSERT INTO repos (id, url, name, source_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("repo-sse", "https://example.com/o/r", "o/r", "git", "done", now);
  db()
    .prepare(
      `INSERT INTO jobs (id, repo_id, status, progress, message, kind, payload_json,
                         priority, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'analyze', '{}', 0, 0, 3, ?, ?)`
    )
    .run("job-sse", "repo-sse", status, status === "done" ? 100 : 0, "msg", now, now);
  return "job-sse";
}

async function readStream(id: string): Promise<string> {
  const req = new NextRequest(`http://localhost/api/jobs/${id}/events`);
  const res = await GET(req, { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("job progress stream", () => {
  it("delivers a terminal event for a job that already finished", async () => {
    const id = seedJob("done");
    const body = await readStream(id);
    expect(body).toContain("event: progress");
    expect(body).toContain('event: end');
    expect(body).toContain('"status":"done"');
  });

  it("delivers a terminal event for a job that already failed", async () => {
    const id = seedJob("error");
    const body = await readStream(id);
    expect(body).toContain('event: end');
    expect(body).toContain('"status":"error"');
  });

  it("404s an unknown job rather than opening a stream", async () => {
    const req = new NextRequest("http://localhost/api/jobs/nope/events");
    const res = await GET(req, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});
