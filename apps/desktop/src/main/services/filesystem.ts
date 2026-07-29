import * as fs from "fs/promises";
import { FileSystemContract, ReadFileRequest, WriteFileRequest } from "../../../shared/contracts/filesystem";
import { Result } from "../../../shared/core/result";
import { Logger } from "../core/logger";

export class FileSystemService implements FileSystemContract {
  constructor(private readonly logger: Logger) {}

  public async readFile(request: ReadFileRequest): Promise<Result<string>> {
    try {
      this.logger.debug("FileSystemService", `Reading file: ${request.path}`);
      const content = await fs.readFile(request.path, { encoding: request.encoding });
      return Result.ok(content);
    } catch (error) {
      this.logger.error("FileSystemService", `Failed to read file: ${request.path}`, error);
      return Result.fail("NOT_FOUND", `Failed to read file at ${request.path}`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async writeFile(request: WriteFileRequest): Promise<Result<void>> {
    try {
      this.logger.debug("FileSystemService", `Writing file: ${request.path}`);
      await fs.writeFile(request.path, request.content);
      return Result.ok(undefined);
    } catch (error) {
      this.logger.error("FileSystemService", `Failed to write file: ${request.path}`, error);
      return Result.fail("INTERNAL_ERROR", `Failed to write file at ${request.path}`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async pathExists(path: string): Promise<Result<boolean>> {
    try {
      await fs.access(path);
      return Result.ok(true);
    } catch {
      return Result.ok(false);
    }
  }
}
