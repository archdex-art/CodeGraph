import { ipcMain, IpcMainInvokeEvent } from "electron";
import { ZodSchema, z } from "zod";
import { Result } from "../../../shared/core/result";
import { Logger } from "../core/logger";
import { PermissionPolicy, PermissionAction } from "../security/permissions";

type Handler<Req, Res> = (request: Req, event: IpcMainInvokeEvent) => Promise<Result<Res>>;

export class IpcRouter {
  constructor(
    private readonly logger: Logger,
    private readonly permissions: PermissionPolicy
  ) {}

  public register<Req, Res>(
    action: PermissionAction,
    channel: string,
    schema: ZodSchema<Req>,
    handler: Handler<Req, Res>
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      this.logger.debug("IpcRouter", `Received IPC request on channel: ${channel}`);

      try {
        const parsedPayload = schema.parse(payload);
        
        const isAllowed = await this.permissions.canExecute(action, event, { payload: parsedPayload });
        if (!isAllowed) {
          return Result.fail("UNAUTHORIZED", "Action denied by security policy.");
        }
        
        return await handler(parsedPayload, event);
      } catch (error) {
        if (error instanceof z.ZodError) {
          this.logger.warn("IpcRouter", `Validation failed for channel ${channel}`, { errors: error.errors });
          return Result.fail("INVALID_INPUT", "Invalid IPC payload", { errors: error.errors });
        }

        this.logger.error("IpcRouter", `Unhandled exception in IPC handler for ${channel}`, error);
        return Result.fail("INTERNAL_ERROR", "Unhandled IPC error", {
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  public registerVoid<Res>(
    action: PermissionAction,
    channel: string,
    handler: Handler<void, Res>
  ): void {
    ipcMain.handle(channel, async (event) => {
      this.logger.debug("IpcRouter", `Received void IPC request on channel: ${channel}`);
      try {
        const isAllowed = await this.permissions.canExecute(action, event);
        if (!isAllowed) {
          return Result.fail("UNAUTHORIZED", "Action denied by security policy.");
        }

        return await handler(undefined as void, event);
      } catch (error) {
        this.logger.error("IpcRouter", `Unhandled exception in IPC handler for ${channel}`, error);
        return Result.fail("INTERNAL_ERROR", "Unhandled IPC error", {
          details: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
