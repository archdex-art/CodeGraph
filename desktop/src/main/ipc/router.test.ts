import { describe, it, expect, vi, beforeEach } from "vitest";
import { IpcRouter } from "./router";
import { PermissionPolicy } from "../security/permissions";
import { Logger } from "../core/logger";
import { z } from "zod";
import { IpcMainInvokeEvent, ipcMain } from "electron";

// Mock electron
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe("IpcRouter", () => {
  let logger: Logger;
  let permissions: PermissionPolicy;
  let router: IpcRouter;

  beforeEach(() => {
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    permissions = {
      canExecute: vi.fn().mockResolvedValue(true),
    } as unknown as PermissionPolicy;

    router = new IpcRouter(logger, permissions);
    
    // Clear mocks
    vi.mocked(ipcMain.handle).mockClear();
  });

  it("should register a channel and handle valid requests", async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: "ok" });
    const schema = z.object({ id: z.number() });

    router.register("fs:read", "test:channel", schema, handler);

    // Extract the registered callback
    expect(ipcMain.handle).toHaveBeenCalledWith("test:channel", expect.any(Function));
    const callback = vi.mocked(ipcMain.handle).mock.calls[0][1];

    const mockEvent = {} as IpcMainInvokeEvent;
    
    // Execute callback with valid payload
    const result = await callback(mockEvent, { id: 42 });

    expect(permissions.canExecute).toHaveBeenCalledWith("fs:read", mockEvent, { payload: { id: 42 } });
    expect(handler).toHaveBeenCalledWith({ id: 42 }, mockEvent);
    expect(result).toEqual({ success: true, data: "ok" });
  });

  it("should block request if permission denied", async () => {
    const handler = vi.fn();
    const schema = z.object({ id: z.number() });

    // Deny permission
    vi.mocked(permissions.canExecute).mockResolvedValue(false);

    router.register("fs:read", "test:channel", schema, handler);
    const callback = vi.mocked(ipcMain.handle).mock.calls[0][1];

    const result = await callback({} as IpcMainInvokeEvent, { id: 42 });

    expect(handler).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("should return INVALID_INPUT result for bad schema validation", async () => {
    const handler = vi.fn();
    const schema = z.object({ id: z.number() });

    router.register("fs:read", "test:channel", schema, handler);
    const callback = vi.mocked(ipcMain.handle).mock.calls[0][1];

    // Pass string instead of number
    const result = await callback({} as IpcMainInvokeEvent, { id: "bad" });

    expect(handler).not.toHaveBeenCalled();
    expect(permissions.canExecute).not.toHaveBeenCalled(); // Validates BEFORE permissions
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("should catch unhandled handler errors and wrap in INTERNAL_ERROR", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("Boom"));
    const schema = z.object({});

    router.register("fs:read", "test:channel", schema, handler);
    const callback = vi.mocked(ipcMain.handle).mock.calls[0][1];

    const result = await callback({} as IpcMainInvokeEvent, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.details).toEqual({ details: "Boom" });
    }
  });
});
