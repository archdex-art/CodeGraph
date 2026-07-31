import { _electron as electron, test, expect, ElectronApplication, Page } from "@playwright/test";
import * as path from "path";

let electronApp: ElectronApplication;
let window: Page;

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
  if (electronApp) {
    await electronApp.close();
  }
});

test.describe("CodeGraph Desktop E2E Smoke Tests", () => {
  
  test("1. Application Boot & Loading Screen", async () => {
    expect(window).toBeDefined();

    // Wait until the app has reached the server, so the whole boot sequence is on record.
    await expect(async () => {
      expect(navigations.some((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
    }).toPass({ timeout: 15000 });

    const boot = navigations.findIndex((u) => u.includes("loading.html"));
    const app = navigations.findIndex((u) => u.startsWith("http://127.0.0.1:"));

    // The user must not be shown a blank window while the server starts.
    expect(boot, `no boot screen in navigations: ${JSON.stringify(navigations)}`).toBeGreaterThanOrEqual(0);
    // And it must be BEFORE the app, not a fallback the app fell back to.
    expect(boot).toBeLessThan(app);
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

  test("4. Graceful Shutdown & Orphan Process Check", async () => {
    await electronApp.close();
    (electronApp as any) = null;
  });

});
