/**
 * Lightweight Dependency Injection Container for the Electron Main Process.
 * Ensures singletons are instantiated in the correct order and provides
 * type-safe resolution.
 */
export class Container {
  private static instance: Container;
  private services: Map<string, any> = new Map();

  private constructor() {}

  public static getInstance(): Container {
    if (!Container.instance) {
      Container.instance = new Container();
    }
    return Container.instance;
  }

  /**
   * Registers a singleton instance in the container.
   */
  public register<T>(token: string, instance: T): void {
    if (this.services.has(token)) {
      throw new Error(`Service [${token}] is already registered.`);
    }
    this.services.set(token, instance);
  }

  /**
   * Resolves a singleton instance from the container.
   */
  public resolve<T>(token: string): T {
    const instance = this.services.get(token);
    if (!instance) {
      throw new Error(`Service [${token}] not found in container.`);
    }
    return instance as T;
  }

  /**
   * Clears the container (useful for testing).
   */
  public clear(): void {
    this.services.clear();
  }
}

export const di = Container.getInstance();
