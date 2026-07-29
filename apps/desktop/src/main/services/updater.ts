import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { Logger } from "../core/logger";
import { EventBus } from "../core/event-bus";

/**
 * Thin wrapper around electron-updater's autoUpdater.
 *
 * Only active in a packaged build with an update feed configured; in dev it is
 * a no-op so `npm run start` never tries to reach a release server. All updater
 * lifecycle events are funnelled through the app EventBus so the rest of the
 * app stays decoupled from electron-updater specifics.
 */
export class UpdateService {
  private wired = false;

  constructor(
    private readonly logger: Logger,
    private readonly eventBus: EventBus
  ) {}

  /** Begin periodic update checks. Safe to call unconditionally. */
  public start(): void {
    if (!app.isPackaged) {
      this.logger.info("UpdateService", "Skipping auto-update: app is not packaged.");
      return;
    }
    this.wireListeners();
    void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      this.logger.error("UpdateService", "checkForUpdatesAndNotify failed.", error);
    });
  }

  /** Manual check triggered from the application menu. */
  public checkNow(): void {
    if (!app.isPackaged) {
      this.logger.info("UpdateService", "Manual update check ignored: app is not packaged.");
      return;
    }
    this.wireListeners();
    void autoUpdater.checkForUpdates().catch((error) => {
      this.logger.error("UpdateService", "Manual update check failed.", error);
    });
  }

  private wireListeners(): void {
    if (this.wired) return;
    this.wired = true;

    autoUpdater.logger = this.logger as unknown as typeof autoUpdater.logger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      this.logger.info("UpdateService", `Update available: ${info.version}`);
      this.eventBus.emit("update:available", info.version);
    });
    autoUpdater.on("update-not-available", () => {
      this.logger.info("UpdateService", "No update available.");
    });
    autoUpdater.on("error", (err) => {
      this.logger.error("UpdateService", "Auto-updater error.", err);
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.logger.info("UpdateService", `Update downloaded: ${info.version}. Will install on quit.`);
    });
  }
}
