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
  const dialogService = new DialogService(logger);
  const fileSystemService = new FileSystemService(logger);
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
    console.error("Fatal bootstrap error:", err);
    app.quit();
  });
}
