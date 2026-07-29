import { z } from "zod";
import { Result } from "../core/result";

// ---------------------------------------------------------------------------
// Schemas for input validation (used by the IPC Router)
// ---------------------------------------------------------------------------

export const OpenDirectoryRequestSchema = z.object({
  title: z.string().optional(),
  defaultPath: z.string().optional(),
  buttonLabel: z.string().optional(),
});

export type OpenDirectoryRequest = z.infer<typeof OpenDirectoryRequestSchema>;

// ---------------------------------------------------------------------------
// Contract Interface
// ---------------------------------------------------------------------------

/**
 * Native Dialog Service Contract.
 * Represents operations requiring native OS dialogs.
 */
export interface DialogContract {
  /**
   * Prompts the user to select a directory.
   * Returns the absolute path of the selected directory, or null if cancelled.
   */
  openDirectory(request?: OpenDirectoryRequest): Promise<Result<string | null>>;
}
