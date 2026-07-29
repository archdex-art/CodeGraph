import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "electron";
import { ConfigManager } from "./config";

// Same shape as src/main/ipc/router.test.ts: only the electron surface
// ConfigManager actually touches. `isPackaged` is mutable because serverPath
// branches on it and both branches are regression-guarded below.
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => "/mock/userData"),
    setName: vi.fn(),
  },
}));

const mockApp = app as unknown as { isPackaged: boolean };

describe("ConfigManager.childEnv", () => {
  const original = { ...process.env };

  beforeEach(() => {
    // A deliberately hostile inherited environment: every value childEnv is
    // responsible for setting is already present with a WRONG value, so a
    // spread-order mistake cannot pass.
    process.env.PORT = "9999";
    process.env.HOSTNAME = "0.0.0.0";
    process.env.NODE_ENV = "production";
    process.env.CG_INHERITED_MARKER = "inherited";
    delete process.env.ELECTRON_RUN_AS_NODE;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it("binds the spawned server to loopback, overriding an inherited public HOSTNAME", () => {
    // The Next server this env launches has no auth in front of it. Inheriting
    // HOSTNAME=0.0.0.0 from the user's shell would publish the operator's
    // repositories and database to their whole network.
    const env = new ConfigManager().childEnv(41234);
    expect(env.HOSTNAME).toBe("127.0.0.1");
  });

  it("sets ELECTRON_RUN_AS_NODE, without which the child boots a second Electron app", () => {
    // spawnServer launches `process.execPath` — the Electron binary, not node.
    // Absent this flag it starts another GUI instance instead of the server.
    const env = new ConfigManager().childEnv(41234);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("uses the allocated port, not an inherited PORT", () => {
    // The port comes from allocatePort()'s free-port search. If the inherited
    // value won, the server would bind a port the supervisor is not polling and
    // the health check would hang.
    const env = new ConfigManager().childEnv(41234);
    expect(env.PORT).toBe("41234");
  });

  it("still passes the rest of the inherited environment through", () => {
    // The whole reason this is a spread and not a fixed literal: the child needs
    // PATH, HOME, proxy vars, and anything else the user's shell provides.
    const env = new ConfigManager().childEnv(41234);
    expect(env.CG_INHERITED_MARKER).toBe("inherited");
  });

  it("reports production NODE_ENV when the app is packaged", () => {
    const env = new ConfigManager().childEnv(41234);
    expect(env.NODE_ENV).toBe("production");
  });
});

describe("ConfigManager.serverPath", () => {
  // Regression guard for the P1 move: outputFileTracingRoot at the monorepo
  // root nests the entrypoint at standalone/apps/web/server.js. The old
  // standalone/server.js path resolved to nothing, and it fails at app LAUNCH
  // rather than at build, so no build gate catches it — the desktop e2e suite
  // was dark at the time, which is exactly how it stayed broken.
  const originalResourcesPath = process.resourcesPath;

  afterEach(() => {
    mockApp.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      configurable: true,
    });
  });

  it("resolves inside the packaged app's resources when packaged", () => {
    // process.resourcesPath only exists inside a real Electron runtime.
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/Resources",
      configurable: true,
    });
    mockApp.isPackaged = true;
    expect(new ConfigManager().serverPath).toBe(
      "/mock/Resources/standalone/apps/web/server.js"
    );
  });

  it("resolves into the assembled build/ tree when unpackaged", () => {
    mockApp.isPackaged = false;
    const resolved = new ConfigManager().serverPath;
    expect(resolved).toContain("build/standalone/apps/web/server.js");
    // Must not regress to the pre-monorepo layout.
    expect(resolved).not.toContain("build/standalone/server.js");
  });
});
