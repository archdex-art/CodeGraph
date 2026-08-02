import { EventEmitter } from "events";
import * as http from "http";
import type { AddressInfo, Socket } from "net";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "child_process";
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

/**
 * The child-process contract, which the happy path never exercises.
 *
 * Everything below is a way to leave a live `next start` behind, or to take the main process
 * down with it. A packaged app that survives its own boot still fails these.
 */
class FakeChild extends EventEmitter {
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();
  public kill = vi.fn();
}

describe("ServerManager child process", () => {
  let logger: Logger;
  let manager: ServerManager;
  let child: FakeChild;

  beforeEach(async () => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const config = {
      isDevelopment: true,
      port: undefined,
      serverPath: "/mock/path/server.js",
      childEnv: () => ({}),
    } as unknown as ConfigManager;
    manager = new ServerManager(logger, config);
    child = new FakeChild();
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockReturnValue(child as never);
    await manager.allocatePort();
  });

  it("reports a failed spawn instead of letting the error event kill the main process", () => {
    // `spawn` reports ENOENT/EACCES asynchronously via an 'error' event. An EventEmitter with
    // no 'error' listener RETHROWS it — in the Electron main process that is the whole app
    // dying with no error screen, on the one failure the error screen exists for.
    const onCrash = vi.fn();
    manager.spawnServer(onCrash);

    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    expect(onCrash).toHaveBeenCalledWith(null);
  });

  it("reports a failed spawn only once when 'error' is followed by 'exit'", () => {
    // Node may emit both. Two crash reports drive two independent recovery attempts.
    const onCrash = vi.fn();
    manager.spawnServer(onCrash);

    child.emit("error", new Error("spawn ENOENT"));
    child.emit("exit", null, "SIGABRT");

    expect(onCrash).toHaveBeenCalledTimes(1);
  });

  it("refuses to spawn a second server while one is still running", () => {
    manager.spawnServer(vi.fn());

    expect(() => manager.spawnServer(vi.fn())).toThrow(/already running/);
    // The handle to the first child must not be overwritten: nothing else can ever reap it.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("kills the child if the main process exits without a graceful shutdown", () => {
    // `before-quit` does not run on an uncaught exception or `app.exit()`, and the child is an
    // ordinary sibling process - it keeps the port bound for as long as the machine is up.
    const baseline = process.listenerCount("exit");
    manager.spawnServer(vi.fn());
    expect(process.listenerCount("exit")).toBe(baseline + 1);

    const guard = process.listeners("exit").at(-1) as () => void;
    guard();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // Released once the child is gone, so a restart loop does not accumulate listeners.
    child.emit("exit", 0, null);
    expect(process.listenerCount("exit")).toBe(baseline);
  });

  it("gives up on a server that accepts the connection and never answers", async () => {
    // A Next server can complete the TCP handshake long before it can serve a request.
    // `http.get` has no implicit deadline, so an unanswered probe never settles and
    // `waitForHealth`'s own timeout is never re-checked: the app hangs on the splash forever.
    const sockets: Socket[] = [];
    const silent = http.createServer(() => {
      /* accept the request and never respond */
    });
    silent.on("connection", (socket) => sockets.push(socket));
    const { promise: listening, resolve: listened } = Promise.withResolvers<void>();
    silent.listen(0, "127.0.0.1", () => listened());
    await listening;
    // Always AddressInfo here: the server was just bound to a TCP host/port, not a pipe.
    const address = silent.address() as AddressInfo;
    const port = address.port;

    const config = {
      isDevelopment: true,
      port,
      serverPath: "/mock/path/server.js",
      childEnv: () => ({}),
    } as unknown as ConfigManager;
    const probing = new ServerManager(logger, config);
    await probing.allocatePort();

    try {
      const started = Date.now();
      await expect(probing.waitForHealth(600)).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });
});
