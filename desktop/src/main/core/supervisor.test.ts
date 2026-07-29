import { describe, it, expect, vi, beforeEach } from "vitest";
import { Supervisor } from "./supervisor";
import { ServerManager } from "./server-manager";
import { StateMachine } from "./state-machine";
import { EventBus } from "./event-bus";
import { Logger } from "./logger";

describe("Supervisor", () => {
  let logger: Logger;
  let eventBus: EventBus;
  let stateMachine: StateMachine;
  let serverManager: ServerManager;
  let supervisor: Supervisor;

  beforeEach(() => {
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    eventBus = {
      on: vi.fn(),
      emit: vi.fn(),
    } as unknown as EventBus;

    stateMachine = {
      state: "BOOTING",
      transition: vi.fn((newState) => {
        (stateMachine as any).state = newState;
      }),
    } as unknown as StateMachine;

    serverManager = {
      allocatePort: vi.fn().mockResolvedValue(4000),
      spawnServer: vi.fn(),
      waitForHealth: vi.fn().mockResolvedValue(true),
      getPort: vi.fn().mockReturnValue(4000),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as ServerManager;

    supervisor = new Supervisor(logger, eventBus, stateMachine, serverManager);
  });

  it("should perform a successful boot sequence", async () => {
    await supervisor.boot();

    expect(serverManager.allocatePort).toHaveBeenCalled();
    expect(serverManager.spawnServer).toHaveBeenCalled();
    expect(serverManager.waitForHealth).toHaveBeenCalled();
    
    expect(stateMachine.transition).toHaveBeenCalledWith("STARTING_SERVER");
    expect(stateMachine.transition).toHaveBeenCalledWith("WAITING_HEALTH");
    expect(stateMachine.transition).toHaveBeenCalledWith("READY");
    
    expect(eventBus.emit).toHaveBeenCalledWith("server:ready", 4000);
  });

  it("should handle graceful shutdown", async () => {
    await supervisor.shutdown();

    expect(stateMachine.transition).toHaveBeenCalledWith("STOPPING");
    expect(serverManager.stop).toHaveBeenCalled();
    expect(stateMachine.transition).toHaveBeenCalledWith("EXITED");
  });

  it("should trigger recovery if health check times out", async () => {
    vi.mocked(serverManager.waitForHealth).mockResolvedValueOnce(false);
    
    // Stub setTimeout to run immediately for testing
    vi.stubGlobal('setTimeout', (fn: any) => fn());

    await supervisor.boot();

    // Verify it transitioned to STARTING_SERVER for retry
    expect(stateMachine.transition).toHaveBeenCalledWith("STARTING_SERVER", "Crash recovery");
    expect(logger.warn).toHaveBeenCalledWith("Supervisor", expect.stringContaining("Restarting"));

    vi.unstubAllGlobals();
  });

  it("should reboot from FAILED on user retry", async () => {
    // Test seam: force the mock's lifecycle state into FAILED.
    const machine = stateMachine as unknown as { state: string };
    machine.state = "FAILED";

    await supervisor.reboot();

    expect(stateMachine.transition).toHaveBeenCalledWith("STARTING_SERVER", "User retry");
    expect(serverManager.spawnServer).toHaveBeenCalled();
    expect(serverManager.waitForHealth).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith("server:ready", 4000);
  });

  it("should ignore reboot when not in FAILED state", async () => {
    // Test seam: force the mock's lifecycle state into READY.
    const machine = stateMachine as unknown as { state: string };
    machine.state = "READY";

    await supervisor.reboot();

    expect(serverManager.spawnServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Supervisor", expect.stringContaining("Reboot requested"));
  });
});
