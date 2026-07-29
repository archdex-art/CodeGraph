import { EventEmitter } from "events";
import TypedEmitter from "typed-emitter";

export type LifecycleState = 
  | "BOOTING" 
  | "STARTING_SERVER" 
  | "WAITING_HEALTH" 
  | "READY" 
  | "STOPPING" 
  | "EXITED" 
  | "FAILED";

export type AppEvents = {
  "state:changed": (state: LifecycleState, reason?: string) => void;
  "server:ready": (port: number) => void;
  "server:crashed": (exitCode: number | null, signal: NodeJS.Signals | null) => void;
  "window:created": () => void;
  "app:shutdown": () => void;
  "app:retry": () => void;
  "update:available": (version: string) => void;
};

/**
 * Centralized Event Bus.
 * Decouples modules by using strict, typed events.
 */
export class EventBus {
  private emitter = new EventEmitter() as TypedEmitter<AppEvents>;

  public on<E extends keyof AppEvents>(event: E, listener: AppEvents[E]): void {
    this.emitter.on(event, listener);
  }

  public once<E extends keyof AppEvents>(event: E, listener: AppEvents[E]): void {
    this.emitter.once(event, listener);
  }

  public off<E extends keyof AppEvents>(event: E, listener: AppEvents[E]): void {
    this.emitter.off(event, listener);
  }

  public emit<E extends keyof AppEvents>(event: E, ...args: Parameters<AppEvents[E]>): void {
    this.emitter.emit(event, ...args);
  }
}
