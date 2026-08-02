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
  private releaseExitGuard: (() => void) | null = null;

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
    if (this.serverProcess) {
      // A second spawn would drop the handle to the first child, and nothing else reaps it:
      // it keeps its port bound and its memory for the lifetime of the machine. Refuse
      // rather than leak — the caller's retry policy decides what to do about it.
      throw new Error("Cannot spawn server: a server process is already running.");
    }
    const serverPath = this.config.serverPath;
    this.logger.info("ServerManager", `Spawning background server at ${serverPath} on port ${this.currentPort}`);
    const child = spawn(process.execPath, [serverPath], {
      env: this.config.childEnv(this.currentPort),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.serverProcess = child;

    // Electron does not always get to run `before-quit`: an uncaught exception in the main
    // process, `app.exit()`, or a renderer crash taking the app down all skip it. The child is
    // an ordinary sibling process, so nothing reaps it and the Next server outlives the app
    // holding its port. A synchronous kill on parent exit closes every one of those paths
    // except a SIGKILL of Electron itself, which no parent-side code can survive.
    const killOnParentExit = (): void => {
      child.kill("SIGKILL");
    };
    process.once("exit", killOnParentExit);
    this.releaseExitGuard = () => {
      process.removeListener("exit", killOnParentExit);
      this.releaseExitGuard = null;
    };

    child.stdout?.on("data", (data) => {
      this.logger.debug("Next.js(out)", data.toString().trim());
    });

    child.stderr?.on("data", (data) => {
      this.logger.error("Next.js(err)", data.toString().trim());
    });

    // Node may emit 'error' then 'exit', or 'error' alone when the spawn itself failed.
    // Either way the supervisor must be told exactly once.
    let reported = false;
    const report = (code: number | null): void => {
      if (this.serverProcess === child) this.serverProcess = null;
      this.releaseExitGuard?.();
      if (reported) return;
      reported = true;
      onCrash(code);
    };

    // Without this listener a failed spawn (bad path, EACCES, EMFILE) emits an 'error' event
    // with no handler, which EventEmitter rethrows — taking the whole main process down
    // instead of showing the error screen.
    child.on("error", (error) => {
      this.logger.error("ServerManager", "Failed to spawn the Next.js process.", error);
      report(null);
    });

    child.on("exit", (code, signal) => {
      this.logger.warn("ServerManager", `Next.js process exited with code ${code}, signal ${signal}`);
      report(code);
    });
  }

  /**
   * Polls the server until it returns HTTP 200 on its health endpoint.
   */
  public async waitForHealth(timeoutMs: number = 10000): Promise<boolean> {
    if (!this.currentPort) return false;
    const url = `http://127.0.0.1:${this.currentPort}/api/health`; // Assuming standard Next.js app has this route, or we hit root
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const budget = Math.min(PROBE_TIMEOUT_MS, deadline - Date.now());
      if (await this.probeHealth(url, budget)) {
        this.logger.info("ServerManager", "Server health check passed.");
        return true;
      }
      const pause = Math.min(RETRY_INTERVAL_MS, deadline - Date.now());
      if (pause <= 0) break;
      const { promise: paused, resolve: resume } = Promise.withResolvers<void>();
      setTimeout(resume, pause);
      await paused;
    }

    this.logger.error("ServerManager", "Server health check timed out.");
    return false;
  }

  /**
   * One health probe, bounded.
   *
   * `http.get` has no implicit deadline: a server that completes the TCP handshake and then
   * never writes a response leaves the request pending forever. That is not hypothetical for a
   * Next server still compiling — and without the timer below the await never settles, so
   * `waitForHealth`'s own `timeoutMs` is never re-checked and the app sits on the splash screen
   * indefinitely with no path to the error screen.
   */
  private probeHealth(url: string, timeoutMs: number): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let req: http.ClientRequest | undefined;

    const finish = (healthy: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Nothing reads the body, and an undrained response holds its socket open.
      req?.destroy();
      resolve(healthy);
    };

    req = http.get(url, (res) => {
      res.resume();
      res.on("error", () => finish(false));
      finish(res.statusCode === 200 || res.statusCode === 404); // Even a 404 means the webserver is answering
    });
    req.on("error", (e) => {
      this.logger.debug("ServerManager", `HTTP Get Error: ${e.message}`);
      finish(false);
    });
    timer = setTimeout(() => {
      this.logger.debug("ServerManager", "Health probe timed out without a response.");
      finish(false);
    }, Math.max(1, timeoutMs));
    req.end();

    return promise;
  }

  public getPort(): number | null {
    return this.currentPort;
  }

  /**
   * Gracefully terminates the server, and does not return until the child is gone or has been
   * SIGKILLed. Callers rely on that: the next spawn allocates a fresh port and the old process
   * would otherwise keep running against the old one.
   */
  public async stop(): Promise<void> {
    const child = this.serverProcess;
    if (!child) return;

    this.logger.info("ServerManager", "Terminating Next.js server process...");

    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
    child.once("exit", () => markExited());
    child.kill("SIGTERM");

    if (!(await settledWithin(exited, GRACEFUL_EXIT_MS))) {
      this.logger.warn("ServerManager", "Server did not shut down gracefully. Sending SIGKILL.");
      child.kill("SIGKILL");
      await settledWithin(exited, FORCED_EXIT_MS);
    }

    if (this.serverProcess === child) this.serverProcess = null;
    this.releaseExitGuard?.();
  }
}

const PROBE_TIMEOUT_MS = 2000;
const RETRY_INTERVAL_MS = 500;
const GRACEFUL_EXIT_MS = 3000;
const FORCED_EXIT_MS = 1000;

/** Resolves true if `task` settled before `ms` elapsed. Never leaves a timer behind. */
async function settledWithin(task: Promise<unknown>, ms: number): Promise<boolean> {
  const { promise: timeout, resolve: expire } = Promise.withResolvers<false>();
  const timer = setTimeout(() => expire(false), ms);
  try {
    return (await Promise.race([task.then(() => true), timeout])) !== false;
  } finally {
    clearTimeout(timer);
  }
}
