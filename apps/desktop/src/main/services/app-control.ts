import { app } from "electron";
import { AppControlContract } from "../../../shared/contracts/app";
import { Result } from "../../../shared/core/result";
import { Logger } from "../core/logger";
import { EventBus } from "../core/event-bus";

/**
 * Native application-lifecycle controls exposed to the renderer (used by the
 * error screen's Retry/Quit buttons).
 */
export class AppControlService implements AppControlContract {
  constructor(
    private readonly logger: Logger,
    private readonly eventBus: EventBus
  ) {}

  public async retry(): Promise<Result<void>> {
    this.logger.info("AppControlService", "Renderer requested engine retry.");
    this.eventBus.emit("app:retry");
    return Result.ok(undefined);
  }

  public async quit(): Promise<Result<void>> {
    this.logger.info("AppControlService", "Renderer requested quit.");
    app.quit();
    return Result.ok(undefined);
  }

  public async getVersion(): Promise<Result<string>> {
    return Result.ok(app.getVersion());
  }
}
