import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * SSRF regression: `isPublicHttpUrl` vets the URL STRING, but git's default
 * `http.followRedirects=initial` then follows a 302 from that vetted host to
 * wherever it points — including the private network the guard exists to keep
 * this server out of (a cloud metadata endpoint, an internal git server).
 *
 * Verified against a real git and a real redirecting server before this test was
 * written: with git's default, `git clone http://<vetted>/repo.git` answered by
 * `302 -> http://127.0.0.1:9/...` fails with "Failed to connect to 127.0.0.1 port 9",
 * i.e. it left the vetted host; with `-c http.followRedirects=false` it fails with
 * "The requested URL returned error: 302" and never connects. That live check cannot
 * be encoded here because `cloneRepo`'s own URL guard rejects a `host:port` URL, so
 * the test locks the argv that produced the safe behaviour.
 */
const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

import { cloneRepo } from "../src/acquire";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capturedArgs(): string[] {
  const call = execFile.mock.calls.at(-1);
  if (!call) throw new Error("git was never invoked");
  return call[1] as string[];
}

describe("cloneRepo — git argv", () => {
  it("refuses redirects on the temp-dir clone path", async () => {
    // promisify(execFile) calls the callback-style signature: (cmd, args, opts, cb).
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: null, r: unknown) => void) =>
      cb(null, { stdout: "", stderr: "" })
    );
    dirs.push(await cloneRepo("https://example.com/owner/repo.git"));
    const args = capturedArgs();
    expect(args.slice(0, 3)).toEqual(["-c", "http.followRedirects=false", "clone"]);
  });

  it("refuses redirects on the persistent-workspace clone path too", async () => {
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "cg-clone-argv-")), "ws");
    dirs.push(path.dirname(dest));
    await cloneRepo("https://example.com/owner/repo.git", dest);
    const args = capturedArgs();
    expect(args.slice(0, 3)).toEqual(["-c", "http.followRedirects=false", "clone"]);
    expect(args).toContain(dest);
  });
});
