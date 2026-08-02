import { IpcMainInvokeEvent } from "electron";
import { Logger } from "../core/logger";

export type PermissionAction = 
  | "fs:read"
  | "fs:write"
  | "dialog:open"
  | "shell:execute"
  | "network:request"
  | "app:control";

/**
 * Basic Permission Policy Engine.
 * For now, in a first-party local app, this just logs and allows.
 * In the future, this is where plugin sandboxing happens.
 */
export class PermissionPolicy {
  constructor(private readonly logger: Logger) {}

  public async canExecute(
    action: PermissionAction,
    event: IpcMainInvokeEvent,
    context?: Record<string, unknown>
  ): Promise<boolean> {
    // Audit log the attempt
    this.logger.debug("PermissionPolicy", `Evaluating permission for action: ${action}`, {
      senderId: event.sender.id,
      context,
    });

    // TODO: In Milestone C / Plugins, implement actual restrictions based on the sender frame
    // For the trusted Next.js frontend, all core actions are permitted.
    const isAllowed = true;

    if (!isAllowed) {
      this.logger.warn("PermissionPolicy", `DENIED action: ${action}`);
    }

    return isAllowed;
  }
}
