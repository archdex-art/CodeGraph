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
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * Identifies the current start attempt. An attempt can fail twice — the child's `exit` event
   * AND the health check giving up on it — and each abandoned attempt leaves a `waitForHealth`
   * still polling for its remaining budget. Without this, every one of those late signals
   * starts another server, so a single crash fans out into several live Next processes.
   */
  private generation = 0;

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
    // A failure can leave a process that was merely unresponsive, not dead.
    await this.serverManager.stop();
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
    if (this.isShuttingDown) return;
    const generation = ++this.generation;
    try {
      await this.serverManager.allocatePort();

      this.serverManager.spawnServer((code) => {
        this.handleServerCrash(code, generation);
      });

      this.stateMachine.transition("WAITING_HEALTH");

      const isHealthy = await this.serverManager.waitForHealth(15000); // 15 sec timeout

      // Another attempt superseded this one while the probe was running; its result is stale
      // and acting on it would spawn a server on top of the live one.
      if (generation !== this.generation) return;

      if (isHealthy) {
        this.restartAttempts = 0; // Reset on success
        this.stateMachine.transition("READY");
        const port = this.serverManager.getPort();
        if (port) {
          this.eventBus.emit("server:ready", port);
        }
      } else {
        // The process is alive, just not answering. Nothing else reaps it, and the next
        // attempt allocates a DIFFERENT port — so skipping this leaves one orphaned Next
        // server per retry, each holding its port until the machine reboots.
        await this.serverManager.stop();
        throw new Error("Server failed health check timeout.");
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.logger.error("Supervisor", "Failed to start server.", error);
      this.handleServerCrash(null, generation);
    }
  }

  private handleServerCrash(code: number | null, generation: number): void {
    if (this.isShuttingDown) return;
    if (generation !== this.generation) return;
    // Retire this attempt so its other failure signal is ignored.
    this.generation++;

    this.eventBus.emit("server:crashed", code, null);

    if (this.restartAttempts < this.MAX_RESTARTS) {
      this.restartAttempts++;
      this.logger.warn("Supervisor", `Server crashed. Restarting (Attempt ${this.restartAttempts}/${this.MAX_RESTARTS})...`);
      this.stateMachine.transition("STARTING_SERVER", "Crash recovery");

      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.startServer();
      }, 1000 * this.restartAttempts);
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
    // A crash seconds before quit leaves a restart pending. Firing it after the app has gone
    // spawns a Next server with nothing left to shut it down.
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.generation++;
    this.stateMachine.transition("STOPPING");
    await this.serverManager.stop();
    this.stateMachine.transition("EXITED");
  }
}
