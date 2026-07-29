import { Logger } from "./logger";
import { EventBus } from "./event-bus";
import { StateMachine } from "./state-machine";
import { ServerManager } from "./server-manager";

/**
 * Orchestrates the boot flow and retry policies.
 * Uses the ServerManager to execute processes, and the StateMachine for transitions.
 */
export class Supervisor {
  private restartAttempts = 0;
  private readonly MAX_RESTARTS = 3;
  private isShuttingDown = false;

  constructor(
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
    private readonly stateMachine: StateMachine,
    private readonly serverManager: ServerManager
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    this.eventBus.on("app:shutdown", () => this.shutdown());
    this.eventBus.on("app:retry", () => this.reboot());
  }

  /**
   * Restarts the boot sequence after a fatal failure (user-triggered from the
   * error screen). Only valid from the FAILED state.
   */
  public async reboot(): Promise<void> {
    if (this.stateMachine.state !== "FAILED") {
      this.logger.warn("Supervisor", `Reboot requested but state is ${this.stateMachine.state}.`);
      return;
    }
    this.logger.info("Supervisor", "Rebooting after failure (user retry).");
    this.restartAttempts = 0;
    this.isShuttingDown = false;
    this.stateMachine.transition("STARTING_SERVER", "User retry");
    await this.startServer();
  }

  /**
   * Begins the application boot sequence.
   */
  public async boot(): Promise<void> {
    if (this.stateMachine.state !== "BOOTING") {
      this.logger.warn("Supervisor", "Boot requested but state is not BOOTING.");
      return;
    }

    try {
      this.stateMachine.transition("STARTING_SERVER");
      await this.startServer();
    } catch (error) {
      this.logger.error("Supervisor", "Fatal error during boot.", error);
      this.fail("Fatal boot error");
    }
  }

  private async startServer(): Promise<void> {
    try {
      await this.serverManager.allocatePort();
      
      this.serverManager.spawnServer((code) => {
        this.handleServerCrash(code);
      });

      this.stateMachine.transition("WAITING_HEALTH");
      
      const isHealthy = await this.serverManager.waitForHealth(15000); // 15 sec timeout
      
      if (isHealthy) {
        this.restartAttempts = 0; // Reset on success
        this.stateMachine.transition("READY");
        const port = this.serverManager.getPort();
        if (port) {
          this.eventBus.emit("server:ready", port);
        }
      } else {
        throw new Error("Server failed health check timeout.");
      }
    } catch (error) {
      this.logger.error("Supervisor", "Failed to start server.", error);
      this.handleServerCrash(null);
    }
  }
  private handleServerCrash(code: number | null): void {
    if (this.isShuttingDown) return;
    
    this.eventBus.emit("server:crashed", code, null);
    
    if (this.restartAttempts < this.MAX_RESTARTS) {
      this.restartAttempts++;
      this.logger.warn("Supervisor", `Server crashed. Restarting (Attempt ${this.restartAttempts}/${this.MAX_RESTARTS})...`);
      this.stateMachine.transition("STARTING_SERVER", "Crash recovery");
      
      const { promise: wait, resolve: tick } = Promise.withResolvers<void>();
      setTimeout(tick, 1000 * this.restartAttempts);
      wait.then(() => this.startServer());
    } else {
      this.fail("Server crashed too many times.");
    }
  }
  private fail(reason: string): void {
    this.logger.error("Supervisor", `Supervisor FAILED: ${reason}`);
    this.stateMachine.transition("FAILED", reason);
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.stateMachine.transition("STOPPING");
    await this.serverManager.stop();
    this.stateMachine.transition("EXITED");
  }
}
