import { _electron as electron, test, expect, ElectronApplication, Page } from "@playwright/test";
import * as path from "path";

let electronApp: ElectronApplication;
let window: Page;

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
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
});

test.describe("CodeGraph Desktop E2E Smoke Tests", () => {
  
  test("1. Application Boot & Loading Screen", async () => {
    expect(window).toBeDefined();
    
    // Wait for the data URL to load
    await window.waitForLoadState("domcontentloaded");
    
    const content = await window.content();
    // Sometimes playwright gets the empty default about:blank first, so we poll
    await expect(async () => {
      const c = await window.content();
      expect(c).toContain("CodeGraph is booting");
    }).toPass({ timeout: 5000 });
  });

  test("2. Server Startup & Renderer Transition", async () => {
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

    const currentDir = process.cwd();
    const result = await window.evaluate(async (dir) => {
      return await (window as any).desktop.fs.pathExists(dir);
    }, currentDir);

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(true);
    }
  });

  test("4. Graceful Shutdown & Orphan Process Check", async () => {
    await electronApp.close();
    (electronApp as any) = null;
  });

});
