import { dialog, BrowserWindow } from "electron";
import { DialogContract, OpenDirectoryRequest } from "../../../shared/contracts/dialog";
import { Result } from "../../../shared/core/result";
import { Logger } from "../core/logger";
import { FsGrants } from "../security/fs-grants";

export class DialogService implements DialogContract {
  constructor(
    private readonly logger: Logger,
    private readonly grants: FsGrants,
  ) {}

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

      // The user picking a directory IS the grant. Nothing else widens filesystem reach.
      const chosen = result.filePaths[0];
      this.grants.grant(chosen);
      this.logger.info("DialogService", `Granted filesystem access to ${chosen}`);
      return Result.ok(chosen);
    } catch (error) {
      this.logger.error("DialogService", "Failed to open directory dialog", error);
      return Result.fail("INTERNAL_ERROR", "Failed to open native dialog", {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
