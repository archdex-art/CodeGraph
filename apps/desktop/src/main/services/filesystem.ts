import * as fs from "fs/promises";
import { FileSystemContract, ReadFileRequest, WriteFileRequest } from "../../../shared/contracts/filesystem";
import { Result } from "../../../shared/core/result";
import { Logger } from "../core/logger";
import { FsGrants } from "../security/fs-grants";

export class FileSystemService implements FileSystemContract {
  constructor(
    private readonly logger: Logger,
    private readonly grants: FsGrants,
  ) {}

  /**
   * Every path crossing the IPC boundary passes through here.
   *
   * `fs:read`/`fs:write` permissions say whether the renderer may touch the disk at all; they
   * say nothing about WHICH file. Without this, a renderer holding `fs:read` could read
   * anything the user can.
   */
  private confine(p: string, op: string): string | null {
    const safe = this.grants.resolveWithinGrant(p);
    if (safe === null) {
      this.logger.error("FileSystemService", `Blocked ${op} outside granted roots: ${p}`);
    }
    return safe;
  }

  public async readFile(request: ReadFileRequest): Promise<Result<string>> {
    try {
      const safe = this.confine(request.path, "read");
      if (safe === null) {
        return Result.fail("UNAUTHORIZED", `Path is outside any directory you have opened`);
      }
      this.logger.debug("FileSystemService", `Reading file: ${safe}`);
      const content = await fs.readFile(safe, { encoding: request.encoding });
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
      const safe = this.confine(request.path, "write");
      if (safe === null) {
        return Result.fail("UNAUTHORIZED", `Path is outside any directory you have opened`);
      }
      this.logger.debug("FileSystemService", `Writing file: ${safe}`);
      await fs.writeFile(safe, request.content);
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
      // Existence is information too: probing outside the grant leaks the filesystem layout.
      const safe = this.confine(path, "pathExists");
      if (safe === null) return Result.ok(false);
      await fs.access(safe);
      return Result.ok(true);
    } catch {
      return Result.ok(false);
    }
  }
}
