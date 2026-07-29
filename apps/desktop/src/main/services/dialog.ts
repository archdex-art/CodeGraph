import { dialog, BrowserWindow } from "electron";
import { DialogContract, OpenDirectoryRequest } from "../../../shared/contracts/dialog";
import { Result } from "../../../shared/core/result";
import { Logger } from "../core/logger";

export class DialogService implements DialogContract {
  constructor(private readonly logger: Logger) {}

  public async openDirectory(request?: OpenDirectoryRequest): Promise<Result<string | null>> {
    try {
      this.logger.debug("DialogService", "Opening directory selection dialog", request);
      
      const focusedWindow = BrowserWindow.getFocusedWindow();
      
      const result = await dialog.showOpenDialog(focusedWindow ?? undefined, {
        title: request?.title ?? "Select Directory",
        defaultPath: request?.defaultPath,
        buttonLabel: request?.buttonLabel ?? "Select",
        properties: ["openDirectory", "createDirectory"],
      });

      if (result.canceled) {
        return Result.ok(null);
      }

      return Result.ok(result.filePaths[0]);
    } catch (error) {
      this.logger.error("DialogService", "Failed to open directory dialog", error);
      return Result.fail("INTERNAL_ERROR", "Failed to open native dialog", {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
