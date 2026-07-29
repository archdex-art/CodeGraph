import { z } from "zod";
import { Result } from "../core/result";

export const ReadFileRequestSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(["utf8", "binary"]).default("utf8"),
});

export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;

export const WriteFileRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

export interface FileSystemContract {
  readFile(request: ReadFileRequest): Promise<Result<string>>;
  writeFile(request: WriteFileRequest): Promise<Result<void>>;
  pathExists(path: string): Promise<Result<boolean>>;
}
