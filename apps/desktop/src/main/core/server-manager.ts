import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as http from "http";
import { Logger } from "./logger";
import { ConfigManager } from "./config";

/**
 * Manages the raw execution of the Next.js standalone Node process.
 * Knows NOTHING about retry policies, windows, or app state.
 */
export class ServerManager {
  private serverProcess: ChildProcess | null = null;
  private currentPort: number | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly config: ConfigManager
  ) {}

  /**
   * Finds an available port on the host machine.
   */
  public async allocatePort(): Promise<number> {
    if (this.config.port) {
      this.currentPort = this.config.port;
      return this.currentPort;
    }
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => {
        if (port) {
          this.currentPort = port;
          resolve(port);
        } else {
          reject(new Error("Failed to allocate dynamic port"));
        }
      });
    });
    return promise;
  }
  /**
   * Spawns the Node.js server. 
   * Expects allocatePort to have been called first.
   */
  public spawnServer(onCrash: (code: number | null) => void): void {
    if (!this.currentPort) {
      throw new Error("Cannot spawn server: port not allocated.");
    }
    const serverPath = this.config.serverPath;
    this.logger.info("ServerManager", `Spawning background server at ${serverPath} on port ${this.currentPort}`);
    this.serverProcess = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: this.config.isDevelopment ? "development" : "production",
        PORT: this.currentPort.toString(),
        HOSTNAME: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.serverProcess.stdout?.on("data", (data) => {
      this.logger.debug("Next.js(out)", data.toString().trim());
    });

    this.serverProcess.stderr?.on("data", (data) => {
      this.logger.error("Next.js(err)", data.toString().trim());
    });

    this.serverProcess.on("exit", (code, signal) => {
      this.logger.warn("ServerManager", `Next.js process exited with code ${code}, signal ${signal}`);
      this.serverProcess = null;
      // Only report as crash if we didn't intentionally stop it
      onCrash(code);
    });
  }

  /**
   * Polls the server until it returns HTTP 200 on its health endpoint.
   */
  public async waitForHealth(timeoutMs: number = 10000): Promise<boolean> {
    if (!this.currentPort) return false;
    const url = `http://127.0.0.1:${this.currentPort}/api/health`; // Assuming standard Next.js app has this route, or we hit root
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        const req = http.get(url, (res) => {
          resolve(res.statusCode === 200 || res.statusCode === 404); // Even a 404 means the webserver is answering
        });
        req.on("error", (e) => {
          this.logger.debug("ServerManager", `HTTP Get Error: ${e.message}`);
          resolve(false);
        });
        req.end();
        const success = await promise;

        if (success) {
          this.logger.info("ServerManager", "Server health check passed.");
          return true;
        }
      } catch (err) {
        this.logger.debug("ServerManager", `Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Wait 500ms before retrying
      const { promise: wait, resolve: tick } = Promise.withResolvers<void>();
      setTimeout(tick, 500);
      await wait;
    }

    this.logger.error("ServerManager", "Server health check timed out.");
    return false;
  }

  public getPort(): number | null {
    return this.currentPort;
  }

  /**
   * Gracefully terminates the server.
   */
  public async stop(): Promise<void> {
    if (!this.serverProcess) return;

    this.logger.info("ServerManager", "Terminating Next.js server process...");
    
    // Attempt graceful shutdown
    this.serverProcess.kill("SIGTERM");
    
    // Wait up to 3 seconds for it to exit, then force kill
    let attempts = 0;
    while (this.serverProcess && attempts < 15) {
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    if (this.serverProcess) {
      this.logger.warn("ServerManager", "Server did not shut down gracefully. Sending SIGKILL.");
      this.serverProcess.kill("SIGKILL");
      this.serverProcess = null;
    }
  }
}
