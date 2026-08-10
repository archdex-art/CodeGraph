import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
/*
 * MOCKS `spawn`, NOT `execFile`. The clone moved onto `runBoundedClone` so a stalled
 * transfer can be timed out on progress rather than on total wall clock, and this test kept
 * asserting the argv of a call that no longer happens: `execFile` was never invoked, the
 * mock never matched, and a real `git clone https://example.com/...` ran and exited 128.
 * A security test that green-lights by accident is worse than none, so it follows the
 * implementation to the call it actually makes.
 */
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

import { cloneRepo } from "../src/acquire";

/** Enough of a ChildProcess for `runBoundedClone`: piped streams and a clean exit. */
function fakeGit() {
  const stream = () => ({ on: () => {}, setEncoding: () => {} });
  const handlers: Record<string, (arg: unknown) => void> = {};
  const child = {
    pid: 4242,
    stdout: stream(),
    stderr: stream(),
    on(event: string, cb: (arg: unknown) => void) {
      handlers[event] = cb;
      /*
       * A microtask, not a timer: it lets `runBoundedClone` finish wiring its remaining
       * listeners before the process "exits", without tying the test to a wall clock.
       */
      if (event === "close") queueMicrotask(() => cb(0));
      return child;
    },
    unref() {},
    kill() {},
  };
  return child;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capturedArgs(): string[] {
  const call = spawn.mock.calls.at(-1);
  if (!call) throw new Error("git was never spawned");
  return call[1] as string[];
}

describe("cloneRepo — git argv", () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockImplementation(() => fakeGit());
  });

  it("refuses redirects on the temp-dir clone path", async () => {
    dirs.push(await cloneRepo("https://example.com/owner/repo.git"));
    expect(capturedArgs().slice(0, 3)).toEqual(["-c", "http.followRedirects=false", "clone"]);
  });

  it("refuses redirects on the persistent-workspace clone path too", async () => {
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "cg-clone-argv-")), "ws");
    dirs.push(path.dirname(dest));
    await cloneRepo("https://example.com/owner/repo.git", dest);
    const args = capturedArgs();
    expect(args.slice(0, 3)).toEqual(["-c", "http.followRedirects=false", "clone"]);
    expect(args).toContain(dest);
  });

  it("still refuses redirects on the no-checkout path", async () => {
    /*
     * The persistent clone gained `--no-checkout`, which is what made the old test's mock
     * miss. Asserted alongside the guard so a future change to the checkout strategy cannot
     * quietly drop the redirect flag with it.
     */
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "cg-clone-argv-")), "ws");
    dirs.push(path.dirname(dest));
    await cloneRepo("https://example.com/owner/repo.git", dest);
    const args = capturedArgs();
    expect(args).toContain("--no-checkout");
    expect(args.indexOf("http.followRedirects=false")).toBeLessThan(args.indexOf("clone"));
  });
});
