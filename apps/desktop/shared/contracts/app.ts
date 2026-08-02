import { z } from "zod";
import { Result } from "../core/result";

// No-payload requests; schema kept for router symmetry/validation.
export const EmptyRequestSchema = z.void().or(z.undefined());

export interface AppControlContract {
  /** Restart the local engine after a fatal boot failure. */
  retry(): Promise<Result<void>>;
  /** Quit the whole application. */
  quit(): Promise<Result<void>>;
  /** The installed application version. */
  getVersion(): Promise<Result<string>>;
}
