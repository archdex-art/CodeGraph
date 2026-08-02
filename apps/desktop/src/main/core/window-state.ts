import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface Display {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 800 };
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

/**
 * Validates and clamps persisted window bounds so a window is never restored
 * off-screen (e.g. an external monitor that is no longer connected) or smaller
 * than the usable minimum. Pure function — no Electron dependency, unit-tested.
 */
export function sanitizeBounds(
  bounds: Partial<WindowBounds> | null | undefined,
  displays: Display[]
): WindowBounds {
  if (!bounds || typeof bounds.width !== "number" || typeof bounds.height !== "number") {
    return { ...DEFAULT_BOUNDS };
  }

  const width = Math.max(MIN_WIDTH, Math.floor(bounds.width));
  const height = Math.max(MIN_HEIGHT, Math.floor(bounds.height));

  // If no position was stored, let the OS center the window.
  if (typeof bounds.x !== "number" || typeof bounds.y !== "number") {
    return { width, height };
  }

  const x = Math.floor(bounds.x);
  const y = Math.floor(bounds.y);

  // The window is considered visible if its top-left corner sits inside any
  // connected display's work area (with a small margin so a title bar is grabbable).
  const visible = displays.some(
    (d) => x >= d.x - 8 && y >= d.y && x < d.x + d.width - 40 && y < d.y + d.height - 40
  );

  return visible ? { width, height, x, y } : { width, height };
}

/**
 * Persists window bounds to a JSON file in the app's userData directory.
 */
export class WindowStateStore {
  private readonly filePath: string;

  constructor(
    private readonly logger: Logger,
    userDataPath: string
  ) {
    this.filePath = path.join(userDataPath, "window-state.json");
  }

  public load(): Partial<WindowBounds> | null {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Partial<WindowBounds>;
      return null;
    } catch {
      // Missing/corrupt file is expected on first launch — not an error.
      return null;
    }
  }

  public save(bounds: WindowBounds): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(bounds), "utf8");
    } catch (error) {
      this.logger.warn("WindowStateStore", "Failed to persist window state", {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
