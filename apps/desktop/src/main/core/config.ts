import { app } from "electron";
import * as path from "path";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().optional(), // If not set, supervisor will pick a free port
});

export type Environment = z.infer<typeof EnvSchema>;

export class ConfigManager {
  private env: Environment;
  public readonly isDevelopment: boolean;
  public readonly port: number | undefined;

  constructor() {
    this.env = EnvSchema.parse({
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
    });
    this.isDevelopment = this.env.NODE_ENV === "development";
    this.port = this.env.PORT;
    
    // Ensure app name is correct before fetching paths
    if (!app.isPackaged) {
      app.setName("CodeGraph-Dev");
    }
  }

  /**
   * The single source of truth for application data (logs, db, config).
   */
  public get userDataPath(): string {
    return app.getPath("userData");
  }
  /**
   * Path to the bundled Next.js standalone server.
   */
  public get serverPath(): string {
    if (!app.isPackaged) {
      // In local dev/unpackaged mode, use the assembled build folder
      // __dirname is dist/src/main/core
      return path.join(__dirname, "../../../../build/standalone/apps/web/server.js");
    }
    // In production, the server is packed alongside the electron app
    return path.join(process.resourcesPath, "standalone/apps/web/server.js");
  }

  /**
   * The environment for the spawned Next.js server process.
   *
   * This is the Electron main process's analogue of `@codegraph/config`'s
   * `childEnv()`, and it exists for the same reason the web ban states: a
   * child process legitimately needs the whole inherited environment, but the
   * `...process.env` spread that produces it must live in exactly one place so
   * the effective configuration stays knowable without grepping (LLD §10.3).
   * `scripts/check_boundaries.py` enforces that this file is that place for
   * `apps/desktop`.
   *
   * The four explicit entries override anything inherited:
   *   · ELECTRON_RUN_AS_NODE — `process.execPath` is the Electron binary, so
   *     without this it boots a second Electron app instead of a Node server.
   *   · NODE_ENV / PORT / HOSTNAME — the allocated port and a loopback-only
   *     bind; the server must never be reachable off-host.
   */
  public childEnv(port: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: this.isDevelopment ? "development" : "production",
      PORT: port.toString(),
      HOSTNAME: "127.0.0.1",
    };
  }
}
