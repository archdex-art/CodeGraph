import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The boot sequence: a window must show the splash BEFORE the server exists, and swap to the
 * app only once a port is live. A user staring at a blank frame while Next starts is the
 * failure this prevents.
 *
 * **Tested here rather than end-to-end, deliberately.** The e2e suite asserted it and failed
 * intermittently on CI with `no boot screen in navigations: ["http://127.0.0.1:45717/"]` — by
 * the time Playwright's launch handshake completed and handed over the window, the app had
 * already transitioned. Recording navigations instead of polling content did not help: the
 * event fires before any listener can attach. The assertion was racing Playwright's own attach
 * latency, not the app, so no amount of care in the e2e makes it deterministic.
 *
 * The ordering is a property of `WindowManager`, and this is where it can be proven.
 */
/**
 * `vi.mock` is hoisted above imports, so anything its factory closes over must be hoisted too —
 * hence `vi.hoisted` rather than plain consts. (A dynamic `await import` also works and was the
 * first version, but top-level await is not available under this package's CommonJS target.)
 */
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn() };
    constructor() {}
    on = vi.fn();
    once = vi.fn();
    isDestroyed = () => false;
    getBounds = () => ({ x: 0, y: 0, width: 1280, height: 800 });
    show = vi.fn();
    loadFile = (p: string) => { calls.push(`loadFile:${p}`); return Promise.resolve(); };
    loadURL = (u: string) => { calls.push(`loadURL:${u}`); return Promise.resolve(); };
  }
  return {
    app: {
      getPath: () => "/tmp/cg-test",
      getName: () => "CodeGraph",
      getVersion: () => "0.0.0-test",
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
      isPackaged: false,
    },
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: vi.fn() },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    },
  };
});

import { WindowManager, isInAppUrl } from "./window-manager";
import { EventBus } from "./event-bus";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const config = { userDataPath: "/tmp/cg-test" } as never;

function fresh() {
  calls.length = 0;
  return new WindowManager(logger, new EventBus(), config);
}

describe("boot sequence", () => {
  beforeEach(() => { calls.length = 0; });

  it("shows the splash when the window is created, before any server exists", () => {
    const wm = fresh();
    wm.create();
    expect(calls.some((c) => c.startsWith("loadFile:") && c.includes("loading.html"))).toBe(true);
    // Nothing may point at a server: none is running at this point in the boot.
    expect(calls.some((c) => c.startsWith("loadURL:http://127.0.0.1"))).toBe(false);
  });

  it("swaps to the app only after a port is available, and in that order", () => {
    const wm = fresh();
    wm.create();
    wm.loadApp(41000);
    const splash = calls.findIndex((c) => c.includes("loading.html"));
    const app = calls.findIndex((c) => c === "loadURL:http://127.0.0.1:41000");
    expect(splash).toBeGreaterThanOrEqual(0);
    expect(app).toBeGreaterThan(splash);
  });

  it("returns to the splash when the user retries after a server that had been running", () => {
    /**
     * The realistic retry: the server came up, later died, the user hits retry. Driven through
     * the whole cycle because a fresh window is the ONE state where a broken `showLoading` still
     * looks correct — a first version of this test called `create()` then emitted the retry, and
     * a mutation making the splash conditional on "no app origin yet" survived it.
     */
    const bus = new EventBus();
    const wm = new WindowManager(logger, bus, config);
    wm.create();
    wm.loadApp(41000);                                  // server was live
    bus.emit("state:changed", "FAILED", "server died");
    calls.length = 0;
    bus.emit("state:changed", "STARTING_SERVER", "User retry");
    expect(calls.some((c) => c.includes("loading.html"))).toBe(true);
  });

  it("shows the error screen when the state machine reports FAILED", () => {
    const bus = new EventBus();
    const wm = new WindowManager(logger, bus, config);
    wm.create();
    calls.length = 0;
    bus.emit("state:changed", "FAILED", "boom");
    expect(calls.some((c) => c.includes("error.html"))).toBe(true);
  });
});

describe("navigation policy", () => {
  /**
   * The renderer that survives a navigation keeps the preload, and the preload is
   * filesystem read/write inside every granted directory. So "may this page navigate
   * itself here" is an authorization decision, and a prefix test is not one.
   */
  const origin = "http://127.0.0.1:41000";
  const staticRoot = "/app/static";
  const allowed = (url: string) => isInAppUrl(origin, staticRoot, url);

  it("admits the app's own origin", () => {
    expect(allowed(origin + "/")).toBe(true);
    expect(allowed(origin + "/repos/abc")).toBe(true);
    expect(allowed("about:blank")).toBe(true);
  });

  it("rejects a foreign host that merely starts with the app origin", () => {
    // userinfo: the host is evil.com, but `startsWith(appOrigin)` is true.
    expect(allowed("http://127.0.0.1:41000@evil.com/")).toBe(false);
    // A different server on the same machine: port 410001, not 41000.
    expect(allowed("http://127.0.0.1:410001/")).toBe(false);
    expect(allowed("https://127.0.0.1:41000/")).toBe(false);
  });

  it("admits only the bundled static pages over file:", () => {
    expect(allowed("file:///app/static/loading.html")).toBe(true);
    expect(allowed("file:///app/static/error.html")).toBe(true);
    expect(allowed("file:///etc/passwd")).toBe(false);
    expect(allowed("file:///app/static-evil/x.html")).toBe(false);
    expect(allowed("file:///app/static/../../etc/passwd")).toBe(false);
  });

  it("rejects everything before a port is known", () => {
    expect(isInAppUrl(null, staticRoot, "http://127.0.0.1:41000/")).toBe(false);
    expect(isInAppUrl(null, staticRoot, "not a url")).toBe(false);
  });
});
