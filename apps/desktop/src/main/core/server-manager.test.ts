import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServerManager } from "./server-manager";
import { ConfigManager } from "./config";
import { Logger } from "./logger";

// Mock child_process and net
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("net", () => {
  return {
    createServer: vi.fn(() => ({
      on: vi.fn(),
      listen: vi.fn((port, host, cb) => cb()),
      address: vi.fn(() => ({ port: 4321 })),
      close: vi.fn((cb) => cb()),
    })),
  };
});

describe("ServerManager", () => {
  let logger: Logger;
  let config: ConfigManager;
  let manager: ServerManager;

  beforeEach(() => {
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    config = {
      isDevelopment: true,
      port: undefined,
      serverPath: "/mock/path/server.js",
    } as unknown as ConfigManager;

    manager = new ServerManager(logger, config);
  });

  it("should dynamically allocate a port if config port is not set", async () => {
    const port = await manager.allocatePort();
    expect(port).toBe(4321);
    expect(manager.getPort()).toBe(4321);
  });

  it("should use the config port if explicitly set", async () => {
    config = { ...config, port: 5000 } as unknown as ConfigManager;
    manager = new ServerManager(logger, config);

    const port = await manager.allocatePort();
    expect(port).toBe(5000);
    expect(manager.getPort()).toBe(5000);
  });
});
