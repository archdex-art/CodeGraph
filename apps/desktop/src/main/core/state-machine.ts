import { EventBus, LifecycleState } from "./event-bus";
import { Logger } from "./logger";

/**
 * Deterministic State Machine for the application lifecycle.
 */
export class StateMachine {
  private currentState: LifecycleState = "BOOTING";
  // Define valid transitions to prevent programming errors
  private readonly transitions: Record<LifecycleState, LifecycleState[]> = {
    BOOTING: ["STARTING_SERVER", "FAILED", "STOPPING"],
    STARTING_SERVER: ["WAITING_HEALTH", "FAILED", "STOPPING"],
    WAITING_HEALTH: ["READY", "FAILED", "STARTING_SERVER", "STOPPING"],
    READY: ["STOPPING", "FAILED"],
    STOPPING: ["EXITED", "FAILED"],
    EXITED: [],
    FAILED: ["STOPPING", "STARTING_SERVER"],
  };

  constructor(
    private readonly logger: Logger,
    private readonly eventBus: EventBus
  ) {}

  public get state(): LifecycleState {
    return this.currentState;
  }

  public transition(newState: LifecycleState, reason?: string): void {
    const validNextStates = this.transitions[this.currentState];
    
    if (!validNextStates.includes(newState)) {
      this.logger.error("StateMachine", `Invalid transition attempted: ${this.currentState} -> ${newState}`);
      return; // Skip invalid transition
    }

    this.logger.info("StateMachine", `State transitioned: ${this.currentState} -> ${newState}`, { reason });
    this.currentState = newState;
    this.eventBus.emit("state:changed", newState, reason);
  }
}
