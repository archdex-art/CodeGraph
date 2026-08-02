import { Logger } from "./logger";
import { ConfigManager } from "./config";
import { EventBus } from "./event-bus";
import { StateMachine } from "./state-machine";
import { Supervisor } from "./supervisor";
import { WindowManager } from "./window-manager";
import { IpcRouter } from "../ipc/router";

export interface ApplicationContext {
  readonly logger: Logger;
  readonly config: ConfigManager;
  readonly eventBus: EventBus;
  readonly stateMachine: StateMachine;
  readonly supervisor: Supervisor;
  readonly windowManager: WindowManager;
  readonly ipcRouter: IpcRouter;
}

/**
 * A central object holding all core dependencies.
 * Services receive this context instead of resolving dependencies individually.
 */
export class AppContext implements ApplicationContext {
  constructor(
    public readonly logger: Logger,
    public readonly config: ConfigManager,
    public readonly eventBus: EventBus,
    public readonly stateMachine: StateMachine,
    public readonly supervisor: Supervisor,
    public readonly windowManager: WindowManager,
    public readonly ipcRouter: IpcRouter
  ) {}
}
