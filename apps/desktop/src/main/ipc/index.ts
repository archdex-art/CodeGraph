import { IpcRouter } from "./router";
import { DialogService } from "../services/dialog";
import { FileSystemService } from "../services/filesystem";
import { AppControlService } from "../services/app-control";
import { OpenDirectoryRequestSchema } from "../../../shared/contracts/dialog";
import { ReadFileRequestSchema, WriteFileRequestSchema } from "../../../shared/contracts/filesystem";
import { z } from "zod";

/**
 * Binds the IPC Router to the actual Native Services.
 */
export function registerIpcHandlers(
  router: IpcRouter,
  dialogService: DialogService,
  fileSystemService: FileSystemService,
  appControlService: AppControlService
): void {
  // --- Dialog Service ---
  router.register(
    "dialog:open",
    "dialog:openDirectory",
    OpenDirectoryRequestSchema.optional().default({}),
    (request) => dialogService.openDirectory(request)
  );

  // --- FileSystem Service ---
  router.register(
    "fs:read",
    "fs:readFile",
    ReadFileRequestSchema,
    (request) => fileSystemService.readFile(request)
  );
  router.register(
    "fs:write",
    "fs:writeFile",
    WriteFileRequestSchema,
    (request) => fileSystemService.writeFile(request)
  );
  router.register(
    "fs:read",
    "fs:pathExists",
    z.string().min(1),
    (request) => fileSystemService.pathExists(request)
  );

  // --- App Control ---
  router.registerVoid("app:control", "app:retry", () => appControlService.retry());
  router.registerVoid("app:control", "app:quit", () => appControlService.quit());
  router.registerVoid("app:control", "app:getVersion", () => appControlService.getVersion());
}
