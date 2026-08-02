import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateMachine } from "./state-machine";
import { EventBus } from "./event-bus";
import { Logger } from "./logger";

describe("StateMachine", () => {
  let logger: Logger;
  let eventBus: EventBus;
  let stateMachine: StateMachine;

  beforeEach(() => {
    // Mock the logger to avoid console spam during tests
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    
    eventBus = new EventBus();
    stateMachine = new StateMachine(logger, eventBus);
  });

  it("should initialize in BOOTING state", () => {
    expect(stateMachine.state).toBe("BOOTING");
  });

  it("should allow valid transitions and emit event", () => {
    const listener = vi.fn();
    eventBus.on("state:changed", listener);

    stateMachine.transition("STARTING_SERVER");

    expect(stateMachine.state).toBe("STARTING_SERVER");
    expect(listener).toHaveBeenCalledWith("STARTING_SERVER", undefined);
    expect(logger.info).toHaveBeenCalled();
  });

  it("should prevent invalid transitions and log error", () => {
    const listener = vi.fn();
    eventBus.on("state:changed", listener);

    // Cannot go from BOOTING directly to READY
    stateMachine.transition("READY");

    expect(stateMachine.state).toBe("BOOTING"); // State should not change
    expect(listener).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("should support the full happy path boot sequence", () => {
    stateMachine.transition("STARTING_SERVER");
    expect(stateMachine.state).toBe("STARTING_SERVER");

    stateMachine.transition("WAITING_HEALTH");
    expect(stateMachine.state).toBe("WAITING_HEALTH");

    stateMachine.transition("READY");
    expect(stateMachine.state).toBe("READY");

    stateMachine.transition("STOPPING");
    expect(stateMachine.state).toBe("STOPPING");

    stateMachine.transition("EXITED");
    expect(stateMachine.state).toBe("EXITED");
  });

  it("should support failure transitions", () => {
    stateMachine.transition("STARTING_SERVER");
    stateMachine.transition("FAILED"); // Start failed

    expect(stateMachine.state).toBe("FAILED");
    
    // READY is not reachable from FAILED
    stateMachine.transition("READY"); // Invalid
    expect(stateMachine.state).toBe("FAILED");

    // User-triggered recovery: FAILED -> STARTING_SERVER is allowed
    stateMachine.transition("STARTING_SERVER", "User retry");
    expect(stateMachine.state).toBe("STARTING_SERVER");

    stateMachine.transition("FAILED");
    stateMachine.transition("STOPPING"); // Valid
    expect(stateMachine.state).toBe("STOPPING");
  });
});
