import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { childEnv } from "@codegraph/config";
import { runBoundedClone } from "../src/acquire";

/**
 * The clone's timer measures SILENCE, not elapsed time.
 *
 * REPRODUCED FAILURE. `git clone` ran under `execFile`'s `timeout: 90_000` — a flat wall
 * clock. A clone downloading steadily was killed at 90 s and the user was told "The clone
 * took too long and was stopped."; whether that happened depended on the operator's
 * bandwidth rather than on the repository. Measured: `microsoft/TypeScript` clones in
 * 15.9 s on a fast link, so the same clone on a link four times slower died mid-transfer
 * having made continuous progress the whole time.
 *
 * Run against FAKE commands, not a real clone. The behaviour under test is entirely about
 * when a timer fires and what gets killed, and a real network clone would make the suite
 * slow, non-deterministic and offline-hostile — the three properties that get a test
 * deleted. The scripts below stand in for git precisely where it matters: they write git's
 * own progress lines to stderr, and one of them spawns a CHILD, because `git clone` is a
 * process tree (`git-remote-https` transfers, `index-pack` writes) and killing only the
 * parent leaves the tree alive.
 *
 * WHY REAL TIME, NOT FAKE TIMERS. Fake timers can only move the clock inside THIS process,
 * and every fact under test belongs to another one: whether the OS delivered output before
 * the window elapsed, and whether a real pid is still running afterwards. Advancing a fake
 * clock would fire the stall timer while the subprocess sat at whatever point the scheduler
 * had reached — i.e. it would test the timer against itself. The windows are therefore kept
 * small (0.3–1 s) and every assertion is one-sided: a slow machine delays a kill, it never
 * turns a kill into a survival or the reverse.
 */

let dir: string;
let steady: string;
let silent: string;
let chatty: string;
let failing: string;
let tick: string;

/**
 * A realistic destination argument, passed to every fake command so the failure messages
 * have something to leak. The argv, the absolute workspace path and the workspace UUID are
 * exactly what the old `execFile` rejection shipped to anonymous visitors (F023, and
 * `apps/web/tests/error-sanitise.test.ts` for the other half of that fix).
 */
const WORKSPACE = "/srv/codegraph/data/workspaces";
const UUID = "6ee8aa2a-3635-4830-b9d6-2c456b9216b9";
const LEAKY_ARGS = ["-c", "http.followRedirects=false", "--depth", "50", `${WORKSPACE}/${UUID}`];

/** git's real progress line, byte for byte — the thing the runner has to parse. */
const PROGRESS = "Receiving objects:  47% (12345/26000), 340.00 MiB | 2.30 MiB/s";

/** Real elapsed time, for the two assertions that can only be made about another process. */
function settleFor(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The rejection's message, or a failure if the run unexpectedly completed. */
async function messageFrom(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the run to be killed, but it completed");
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cg-stall-"));
  tick = path.join(dir, "tick");
  writeFileSync(tick, "", "utf8");

  // `.cjs` so `require` works regardless of what the nearest package.json says.
  steady = path.join(dir, "steady.cjs");
  silent = path.join(dir, "silent.cjs");
  chatty = path.join(dir, "chatty.cjs");
  failing = path.join(dir, "failing.cjs");

  // Emits progress well past the stall window, then exits 0 — a healthy slow clone.
  writeFileSync(
    steady,
    `let i = 0;
     const t = setInterval(() => {
       process.stderr.write("Receiving objects:  " + i + "% (" + i + "/100), " + i + ".00 MiB | 1.00 MiB/s\\r");
       if (++i >= 12) { clearInterval(t); process.exit(0); }
     }, 40);\n`,
    "utf8",
  );

  // One progress line, then permanent silence — and a CHILD that keeps appending to
  // `tick`, so the test can tell "the parent was signalled" from "the tree is gone".
  writeFileSync(
    silent,
    `const { spawn } = require("node:child_process");
     spawn(process.execPath, ["-e",
       'const { appendFileSync } = require("node:fs");' +
       'setInterval(() => appendFileSync(' + JSON.stringify(process.argv[2]) + ', "x"), 25);'
     // stdio ignored rather than inherited: a grandchild writing to our stderr would both
     // rearm the stall timer and hold the pipe open past its parent's exit.
     ], { stdio: "ignore" });
     process.stderr.write(${JSON.stringify(PROGRESS)} + "\\r");
     setInterval(() => {}, 1000);\n`,
    "utf8",
  );

  // Never stops talking and never finishes: the case a stall timer structurally cannot see.
  writeFileSync(
    chatty,
    `setInterval(() => process.stderr.write("Receiving objects:  50% (1/2), 1.00 MiB | 1.00 MiB/s\\r"), 50);\n`,
    "utf8",
  );

  // Fails the way git fails: a diagnosis on stderr and a non-zero exit.
  writeFileSync(failing, `process.stderr.write("fatal: repository not found\\n"); process.exit(128);\n`, "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runBoundedClone", () => {
  it("lets a process that keeps producing output run past the stall window", async () => {
    const started = Date.now();
    await expect(
      runBoundedClone(process.execPath, [steady, tick, ...LEAKY_ARGS], {
        stallMs: 150,
        maxMs: 30_000,
        env: childEnv(),
      }),
    ).resolves.toBeUndefined();
    // The whole point: it outlived several stall windows because it never went quiet. Without
    // this bound the test would also pass against a wall clock short enough to kill it.
    expect(Date.now() - started).toBeGreaterThan(300);
  });

  it("kills a process that goes silent, and says what it was doing", async () => {
    const message = await messageFrom(
      runBoundedClone(process.execPath, [silent, tick, ...LEAKY_ARGS], {
        stallMs: 1_000,
        maxMs: 30_000,
        env: childEnv(),
      }),
    );
    expect(message).toBe(
      "Clone stalled: no progress for 1s (last: Receiving objects 47%, 340.00 MiB)." +
        " The repository may be very large or the network slow.",
    );
  });

  it("kills the whole process tree, not just the process it spawned", async () => {
    await messageFrom(
      runBoundedClone(process.execPath, [silent, tick, ...LEAKY_ARGS], {
        stallMs: 300,
        maxMs: 30_000,
        env: childEnv(),
      }),
    );
    // Sampled after a settling delay rather than at the instant of rejection: the child is
    // signalled with the group but is not required to die in lockstep with its parent.
    await settleFor(250);
    const settled = statSync(tick).size;
    await settleFor(400);
    // A surviving child appends every 25ms, so 400ms of no growth is not luck.
    expect(statSync(tick).size).toBe(settled);
  });

  it("still stops a process that dribbles output forever", async () => {
    const message = await messageFrom(
      runBoundedClone(process.execPath, [chatty, tick, ...LEAKY_ARGS], {
        // A stall window it can never reach: it prints every 50ms. Only the ceiling ends it.
        stallMs: 60_000,
        maxMs: 1_000,
        env: childEnv(),
      }),
    );
    expect(message).toBe(
      "Clone exceeded the 1s limit (last: Receiving objects 50%, 1.00 MiB)." +
        " The repository may be very large or the network slow.",
    );
  });

  it("reports a non-zero exit through stderr rather than through the command line", async () => {
    // Not a timeout at all, but the same message surface: `classifyIndexFailure` reads
    // `.stderr` to tell "repository not found" from "authentication failed", so that field
    // had to survive the move off `execFile` — while the argv must not reappear in the text.
    let caught: unknown;
    try {
      await runBoundedClone(process.execPath, [failing, ...LEAKY_ARGS], {
        stallMs: 30_000,
        maxMs: 30_000,
        env: childEnv(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error) || !("stderr" in caught)) throw new Error("expected a git-shaped rejection");
    expect(caught.stderr).toContain("fatal: repository not found");
    expect(caught.message).toBe("git exited with code 128");
  });
});

/**
 * The failure text reaches a browser through `classifyIndexFailure`. The version of this
 * path that used `execFile` put the absolute workspace path, the workspace UUID and the
 * full `git -c http.followRedirects=false clone …` command line into an anonymous
 * visitor's error card, to deliver two useful words.
 */
describe("what a stall is allowed to disclose", () => {
  let messages: string[];

  beforeAll(async () => {
    messages = [
      await messageFrom(
        runBoundedClone(process.execPath, [silent, tick, ...LEAKY_ARGS], {
          stallMs: 300,
          maxMs: 30_000,
          env: childEnv(),
        }),
      ),
      await messageFrom(
        runBoundedClone(process.execPath, [chatty, tick, ...LEAKY_ARGS], {
          stallMs: 60_000,
          maxMs: 400,
          env: childEnv(),
        }),
      ),
    ];
  });

  it.each([
    ["the workspace path", WORKSPACE],
    ["the workspace UUID", UUID],
    ["git's flags", "http.followRedirects"],
    ["the command line", "git -c"],
    ["the interpreter path", process.execPath],
  ])("carries no %s", (_label, needle) => {
    for (const message of messages) expect(message).not.toContain(needle);
  });

  it("carries no absolute path of any kind", () => {
    // Deliberately blunt: the message is prose plus a phase name and a byte count, so a path
    // separator appearing at all means something interpolated the environment into it.
    for (const message of messages) expect(message).not.toMatch(/\//);
  });

  it("names the phase, so the report is actionable rather than just a refusal", () => {
    // The whole reason the runner parses progress: "no progress for 60s" alone cannot tell an
    // operator whether the transfer never started or died at 90% of a 2 GB pack.
    expect(messages[0]).toContain("Receiving objects 47%, 340.00 MiB");
    expect(messages[1]).toContain("Receiving objects 50%, 1.00 MiB");
  });
});
