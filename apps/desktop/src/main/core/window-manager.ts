import { app, BrowserWindow, shell, screen } from "electron";
import * as path from "path";
import { fileURLToPath } from "url";
import { EventBus } from "./event-bus";
import { Logger } from "./logger";
import { ConfigManager } from "./config";
import { WindowBounds, WindowStateStore, sanitizeBounds, DEFAULT_BOUNDS } from "./window-state";

/**
 * Whether the renderer may navigate itself to `url`.
 *
 * Exported and pure because this is the boundary that decides who gets `window.desktop`: the
 * preload is attached to the webContents, not to a page, so anything this admits inherits
 * filesystem read/write inside every directory the user has granted.
 *
 * The prefix test this replaces was not an origin check. `http://127.0.0.1:41000@evil.com/`
 * starts with the app origin and resolves to a host of `evil.com`; so does
 * `http://127.0.0.1:410001/`, a different server on the same machine. Either one silently
 * hands the desktop API to a foreign page.
 */
export function isInAppUrl(appOrigin: string | null, staticRoot: string, url: string): boolean {
  if (url === "about:blank") return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === "file:") {
    // Only the bundled splash and error pages. A file: URL carries the preload too, so an
    // arbitrary HTML file on disk would otherwise be handed the same API.
    let filePath: string;
    try {
      filePath = path.resolve(fileURLToPath(parsed));
    } catch {
      return false;
    }
    return filePath === staticRoot || filePath.startsWith(staticRoot + path.sep);
  }

  if (appOrigin === null) return false;
  return parsed.origin === appOrigin;
}

/**
 * Manages the Electron BrowserWindow.
 * Reacts to events from the Supervisor/EventBus, restores/persists window
 * geometry, and enforces navigation/window-open security policy.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private appOrigin: string | null = null;
  private readonly stateStore: WindowStateStore;
  /** The bundled splash/error pages. Also the only file: tree the renderer may navigate to. */
  private readonly staticRoot = path.resolve(__dirname, "../../../../static");
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
    config: ConfigManager
  ) {
    this.stateStore = new WindowStateStore(logger, config.userDataPath);
    this.setupListeners();
  }

  private setupListeners(): void {
    this.eventBus.on("server:ready", (port) => {
      this.loadApp(port);
    });

    this.eventBus.on("state:changed", (state, reason) => {
      if (state === "FAILED") {
        this.showErrorScreen();
      } else if (state === "STARTING_SERVER" && reason === "User retry") {
        this.showLoading();
      }
    });
  }

  public getWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  public hasWindow(): boolean {
    return this.mainWindow !== null && !this.mainWindow.isDestroyed();
  }

  public create(): void {
    if (this.hasWindow()) {
      this.mainWindow?.focus();
      return;
    }

    this.logger.info("WindowManager", "Creating main window...");

    const bounds = this.restoreBounds();

    this.mainWindow = new BrowserWindow({
      ...bounds,
      minWidth: 800,
      minHeight: 600,
      show: false, // Wait until ready-to-show to prevent flickering
      backgroundColor: "#0b0b0f",
      title: app.getName(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, "../../preload/index.js"),
      },
    });

    this.mainWindow.on("ready-to-show", () => {
      this.mainWindow?.show();
    });

    this.mainWindow.on("resize", () => this.scheduleSave());
    this.mainWindow.on("move", () => this.scheduleSave());

    this.mainWindow.on("close", () => this.persistBounds());

    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });

    this.applySecurityPolicy(this.mainWindow);
    this.showLoading();
  }

  private restoreBounds(): WindowBounds {
    const displays = screen.getAllDisplays().map((d) => ({
      x: d.workArea.x,
      y: d.workArea.y,
      width: d.workArea.width,
      height: d.workArea.height,
    }));
    return sanitizeBounds(this.stateStore.load(), displays);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persistBounds(), 400);
  }

  private persistBounds(): void {
    if (!this.hasWindow()) return;
    if (this.mainWindow!.isMinimized() || this.mainWindow!.isFullScreen()) return;
    const b = this.mainWindow!.getBounds();
    this.stateStore.save({ width: b.width, height: b.height, x: b.x, y: b.y });
  }

  /**
   * Denies in-app navigation to any origin other than the running app, and
   * routes external links to the user's default browser. This is the last
   * line of defence even though the app only loads a local server.
   */
  private applySecurityPolicy(window: BrowserWindow): void {
    const isInApp = (url: string): boolean =>
      isInAppUrl(this.appOrigin, this.staticRoot, url);

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http:") || url.startsWith("https:")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    window.webContents.on("will-navigate", (event, url) => {
      if (isInApp(url)) return;
      event.preventDefault();
      if (url.startsWith("http:") || url.startsWith("https:")) {
        this.logger.info("WindowManager", `Opening external URL in browser: ${url}`);
        void shell.openExternal(url);
      } else {
        this.logger.warn("WindowManager", `Blocked navigation to disallowed URL: ${url}`);
      }
    });

    window.webContents.on("will-attach-webview", (event) => {
      // No embedded webviews are expected; reject to shrink attack surface.
      event.preventDefault();
    });
  }

  public showLoading(): void {
    if (!this.mainWindow) return;
    this.logger.info("WindowManager", "Loading splash screen...");
    const loadingPath = path.join(__dirname, "../../../../static/loading.html");
    void this.mainWindow.loadFile(loadingPath);
  }

  public loadApp(port: number): void {
    if (!this.mainWindow) return;
    this.appOrigin = `http://127.0.0.1:${port}`;
    this.logger.info("WindowManager", `Loading frontend at ${this.appOrigin}`);
    void this.mainWindow.loadURL(this.appOrigin);
  }

  public showErrorScreen(): void {
    if (!this.mainWindow) return;
    this.logger.error("WindowManager", "Showing error screen.");
    const errorPath = path.join(__dirname, "../../../../static/error.html");
    void this.mainWindow.loadFile(errorPath).catch(() => {
      // Fallback if the packaged error page is somehow unavailable.
      void this.mainWindow?.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            "<body style='background:#0b0b0f;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><h1>CodeGraph failed to start.</h1></body>"
          )
      );
    });
  }

}

export { DEFAULT_BOUNDS };
