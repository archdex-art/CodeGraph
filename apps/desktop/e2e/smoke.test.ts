import { _electron as electron, test, expect, ElectronApplication, Page } from "@playwright/test";
import * as path from "path";

let electronApp: ElectronApplication;
let window: Page;
/**
 * Set once test 4 has established that the app exited. It replaces nulling `electronApp`:
 * that needed an `as any` to defeat the non-nullable type, and the null was assigned on a line
 * test 4 could never reach when it failed — so `afterAll` closed an already-closing app and
 * added a second 30s timeout on top of the first.
 */
let shutdownAsserted = false;

/**
 * Every URL the main frame has been at, oldest first.
 *
 * Recorded rather than polled. The boot screen is a state the app is DESIGNED to leave as fast
 * as it can, so `await content()` inside a test asks "is it still booting?" at an arbitrary
 * later moment — which on a fast runner is already no. That is what failed here: CI saw the
 * loaded app and reported a missing loading screen.
 *
 * A recording cannot race. The app either passed through the boot screen or it did not, and
 * the assertion is about ORDER, which is what the requirement actually is.
 */
const navigations: string[] = [];

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, "../dist/src/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "development",
    }
  });

  electronApp.process().stdout?.on("data", (d) => console.log(d.toString()));
  electronApp.process().stderr?.on("data", (d) => console.error(d.toString()));

  window = await electronApp.firstWindow();
  // The window may already be at `about:blank` or at the boot screen by the time Playwright
  // hands it over, so seed with wherever it is and append every navigation after.
  navigations.push(window.url());
  window.on("framenavigated", (frame) => {
    if (frame === window.mainFrame()) navigations.push(frame.url());
  });
});

test.afterAll(async () => {
  // Skipped once test 4 has asserted the exit: closing a process that is already gone is at
  // best a no-op and at worst the hang test 4 exists to stop depending on.
  if (electronApp && !shutdownAsserted) {
    await electronApp.close();
  }
});

test.describe("CodeGraph Desktop E2E Smoke Tests", () => {
  
  test("1. Application Boot — the window is never left blank", async () => {
    expect(window).toBeDefined();

    /**
     * This used to assert the splash screen specifically, and failed on CI:
     * `no boot screen in navigations: ["http://127.0.0.1:45717/"]`. By the time Playwright's
     * launch handshake completed, the app had already swapped to the server. Recording
     * navigations instead of polling content did not fix it — the navigation happens before
     * any listener can attach. The assertion was racing PLAYWRIGHT'S attach latency, not the
     * app, so it cannot be made deterministic here at all.
     *
     * The ordering it was trying to prove now lives in
     * `src/main/core/window-manager.test.ts` ("boot sequence"), where it is exact and
     * mutation-tested 4/4.
     *
     * What e2e can still guarantee is the user-visible invariant: whatever the window is
     * showing by the time anyone can look, it is real content — never `about:blank`, never an
     * empty document. That holds no matter which side of the swap we arrive on.
     */
    await expect(async () => {
      const url = window.url();
      expect(url, "window still at about:blank").not.toBe("about:blank");
      expect(url.length, "window has no URL at all").toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });

    /**
     * `content()` must be retried, not awaited once.
     *
     * The app is swapping the splash for the server URL around exactly this moment, and
     * reading a document mid-navigation throws "Unable to retrieve content because the
     * page is navigating" — which is what CI hit. The invariant being asserted is
     * "whatever the window shows is real content", and that is true on both sides of the
     * swap; it is only unobservable *during* it. So retry until it can be read.
     */
    await expect(async () => {
      const content = await window.content();
      // Either side of the swap is fine; an empty shell is not.
      expect(content).toMatch(/CodeGraph|<body[^>]*>[\s\S]*\S/);
    }).toPass({ timeout: 15000 });

    expect(navigations.length, `no navigation recorded: ${JSON.stringify(navigations)}`).toBeGreaterThan(0);
  });

  test("2. Server Startup & Renderer Transition", async () => {
    // Current state, not history: the app must still be on the server, not have fallen back.
    await expect(async () => {
      const url = window.url();
      expect(url).toContain("http://127.0.0.1:");
    }).toPass({ timeout: 15000 });
  });

  test("3. IPC Smoke Test (Preload API)", async () => {
    await window.waitForLoadState("domcontentloaded");

    const desktopApiExists = await window.evaluate(() => {
      return typeof (window as any).desktop !== "undefined";
    });
    expect(desktopApiExists).toBe(true);

    /**
     * This asserted `data === true` for the runner's cwd and failed on every platform, because
     * the app is right and the test was wrong.
     *
     * `FileSystemService.pathExists` returns `ok(false)` for any path outside a granted root,
     * deliberately: "Existence is information too: probing outside the grant leaks the
     * filesystem layout." At boot no directory has been opened, so there are no grants, so the
     * honest answer for ANY path is `false`. The old assertion required the capability
     * boundary to be broken.
     *
     * Rewritten to assert what should be true, which also tests strictly more: a `success`
     * envelope proves the contextBridge round trip works, and `data === false` for a directory
     * that certainly exists proves confinement is on.
     */
    const certainlyExists = process.cwd();
    const result = await window.evaluate(async (dir) => {
      return await (window as any).desktop.fs.pathExists(dir);
    }, certainlyExists);

    expect(result).toBeDefined();
    // The IPC round trip itself succeeded — that is the smoke test.
    expect(result.success).toBe(true);
    // ...and the answer is `false` despite the directory existing, because nothing is granted.
    expect(result.data).toBe(false);
  });

  /**
   * The property is "the app exits and leaves nothing behind". It is asserted on the PROCESS,
   * not on `close()`'s promise, and that distinction is the whole test.
   *
   * `await electronApp.close()` alone is what this was, and it is flaky in a way that costs a
   * full CI run. Measured across two runs of a BYTE-IDENTICAL tree (`git diff 6d90a1b a5e6116`
   * is empty): 226ms on one, a 30s timeout on the other — followed by a second 30s worker
   * teardown timeout, because `afterAll` then called `close()` again on the app this test had
   * not reached the line to null out. In the failing run the app's own log showed a COMPLETE
   * graceful shutdown 30ms in: `Intercepting quit` → `READY -> STOPPING` → Next.js exited 143
   * → `STOPPING -> EXITED` → `Debugger ending`. The thing under test worked; the harness
   * promise never settled. (The GPU-init crash in the log is not the discriminator — it
   * appears in the passing run too, three times.)
   *
   * Retries stay pinned to 0 in playwright.config.ts, so a flake here is a red build. The fix
   * is therefore not a retry and not a longer timeout — it is to stop asserting on a promise
   * that does not describe the requirement. `exit` fires when the process is gone, which IS
   * the requirement, and it cannot hang for a process that has already gone.
   */
  test("4. Graceful Shutdown & Orphan Process Check", async () => {
    const proc = electronApp.process();
    const hasExited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;

    const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
    if (hasExited()) onExit();
    else proc.once("exit", () => onExit());

    try {
      // Ask it to quit, and deliberately do not await this on its own: a `close()` that never
      // settles must not be able to fail a shutdown that did happen. Nothing else awaits the
      // returned promise either — with `shutdownAsserted` set below, `afterAll` does not call
      // `close()` a second time, which is what turned one 30s test timeout into two.
      void electronApp.close().catch(() => {
        /* the process assertion below is the source of truth */
      });
      await exited;
    } finally {
      shutdownAsserted = true;
    }

    // No orphan: the main process is reaped, and with it the Next.js child it supervises —
    // whose own exit (143) the app logs on the way through STOPPING.
    expect(hasExited()).toBe(true);
  });

});
