import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus";

describe("EventBus", () => {
  it("should emit and listen to events", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on("server:ready", listener);
    bus.emit("server:ready", 4000);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(4000);
  });

  it("should support once() listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.once("app:shutdown", listener);
    
    bus.emit("app:shutdown");
    bus.emit("app:shutdown");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should allow unsubscribing via off()", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on("state:changed", listener);
    bus.off("state:changed", listener);
    
    bus.emit("state:changed", "READY");

    expect(listener).not.toHaveBeenCalled();
  });
});
