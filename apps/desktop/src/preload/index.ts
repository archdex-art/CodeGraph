import { contextBridge, ipcRenderer } from "electron";
import { DialogContract, OpenDirectoryRequest } from "../../shared/contracts/dialog";
import { FileSystemContract, ReadFileRequest, WriteFileRequest } from "../../shared/contracts/filesystem";
import { AppControlContract } from "../../shared/contracts/app";
import { Result } from "../../shared/core/result";

// ---------------------------------------------------------------------------
// IPC Invocation Wrappers
// ---------------------------------------------------------------------------
const invokeIpc = async <T>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
  try {
    // The IPC Router in the Main process is strictly typed to return Result<T>
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    // This catches lower-level Electron serialization/routing errors,
    // ensuring the renderer always receives a Result object.
    return Result.fail("INTERNAL_ERROR", "IPC communication failed", {
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

// ---------------------------------------------------------------------------
// Desktop API Namespaces
// ---------------------------------------------------------------------------

const dialogApi: DialogContract = {
  openDirectory: (request?: OpenDirectoryRequest) => invokeIpc("dialog:openDirectory", request),
};

const fsApi: FileSystemContract = {
  readFile: (request: ReadFileRequest) => invokeIpc("fs:readFile", request),
  writeFile: (request: WriteFileRequest) => invokeIpc("fs:writeFile", request),
  pathExists: (path: string) => invokeIpc("fs:pathExists", path),
};

const appApi: AppControlContract = {
  retry: () => invokeIpc("app:retry"),
  quit: () => invokeIpc("app:quit"),
  getVersion: () => invokeIpc("app:getVersion"),
};

// ---------------------------------------------------------------------------
// Context Bridge Exposure
// ---------------------------------------------------------------------------

const desktopApi = {
  dialog: dialogApi,
  fs: fsApi,
  app: appApi,
};

// Expose strictly typed APIs to the renderer
contextBridge.exposeInMainWorld("desktop", desktopApi);

// Type declaration for the Next.js frontend to consume
export type DesktopAPI = typeof desktopApi;
