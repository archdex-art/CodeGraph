import { app } from "electron";
import { di } from "./core/di";
import { Logger } from "./core/logger";
import { ConfigManager } from "./core/config";
import { EventBus } from "./core/event-bus";
import { StateMachine } from "./core/state-machine";
import { ServerManager } from "./core/server-manager";
import { Supervisor } from "./core/supervisor";
import { WindowManager } from "./core/window-manager";
import { IpcRouter } from "./ipc/router";
import { AppContext } from "./core/context";
import { FsGrants } from "./security/fs-grants";
import { DialogService } from "./services/dialog";
import { FileSystemService } from "./services/filesystem";
import { AppControlService } from "./services/app-control";
import { UpdateService } from "./services/updater";
import { PermissionPolicy } from "./security/permissions";
import { registerIpcHandlers } from "./ipc";
import { buildApplicationMenu } from "./core/menu";

async function bootstrap() {
  // 1. Dependency Injection Setup
  const logger = new Logger();
  di.register("logger", logger);

  const config = new ConfigManager();
  di.register("config", config);

  const eventBus = new EventBus();
  di.register("eventBus", eventBus);

  const stateMachine = new StateMachine(logger, eventBus);
  di.register("stateMachine", stateMachine);

  const serverManager = new ServerManager(logger, config);
  di.register("serverManager", serverManager);

  const supervisor = new Supervisor(logger, eventBus, stateMachine, serverManager);
  di.register("supervisor", supervisor);

  const windowManager = new WindowManager(logger, eventBus, config);
  di.register("windowManager", windowManager);

  const permissions = new PermissionPolicy(logger);
  di.register("permissions", permissions);

  const ipcRouter = new IpcRouter(logger, permissions);
  di.register("ipcRouter", ipcRouter);

  // 2. Application Context
  const context = new AppContext(
    logger,
    config,
    eventBus,
    stateMachine,
    supervisor,
    windowManager,
    ipcRouter
  );
  di.register("context", context);

  // 3. Native Services & IPC Binding
  // One grant store: the dialog is the only thing that widens it, the filesystem service the
  // only thing that reads it. Access follows the user's explicit directory choice and nothing
  // else - see security/fs-grants.ts.
  const fsGrants = new FsGrants();
  const dialogService = new DialogService(logger, fsGrants);
  const fileSystemService = new FileSystemService(logger, fsGrants);
  const appControlService = new AppControlService(logger, eventBus);
  const updateService = new UpdateService(logger, eventBus);
  registerIpcHandlers(ipcRouter, dialogService, fileSystemService, appControlService);

  // 4. Lifecycle binding
  app.on("ready", () => {
    logger.info("Main", "Electron App Ready. Beginning boot sequence...");
    buildApplicationMenu({ onCheckForUpdates: () => updateService.checkNow() });
    windowManager.create();
    supervisor.boot();
    updateService.start();
  });

  // macOS: re-create the window when the dock icon is clicked and no windows are open.
  app.on("activate", () => {
    if (!windowManager.hasWindow()) {
      windowManager.create();
      if (stateMachine.state === "READY") {
        const port = serverManager.getPort();
        if (port) windowManager.loadApp(port);
      }
    }
  });

  app.on("window-all-closed", () => {
    logger.info("Main", "All windows closed.");
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", (event) => {
    if (stateMachine.state !== "EXITED" && stateMachine.state !== "STOPPING") {
      logger.info("Main", "Intercepting quit to shutdown gracefully.");
      event.preventDefault();
      
      // Perform graceful shutdown, then quit again
      supervisor.shutdown().then(() => {
        app.quit();
      });
    }
  });
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  bootstrap().catch((err) => {
    // `new Logger()` is the first statement in bootstrap(), so any later
    // failure has a real logging channel and must use it — electron-log writes
    // to a file the user can actually send us, which a console.error in a
    // packaged Electron main process does not (there is no attached terminal).
    //
    // The console fallback is reachable only if the Logger itself failed to
    // construct, i.e. there is no logging channel to route through. That single
    // case is declared in scripts/check_boundaries.py's DESKTOP_CONSOLE_OWNERS
    // rather than left to look like an ordinary console call.
    try {
      new Logger().error("Main", "Fatal bootstrap error", err);
    } catch {
      console.error("Fatal bootstrap error (logger unavailable):", err);
    }
    app.quit();
  });
}
