import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

export interface LoadedSnapshot {
  hash: string;
  dir: string; // Temporary directory containing the exact state of the repo
  cleanup: () => Promise<void>;
}

/**
 * Loads repository contents for any commit into an isolated temporary directory
 * without modifying the user's working tree.
 */
export async function loadSnapshot(repoDir: string, hash: string): Promise<LoadedSnapshot> {
  const tempDir = await mkdtemp(join(tmpdir(), `codegraph-snapshot-${hash}-`));
  
  try {
    // Use a physical temporary file to completely bypass Node.js maxBuffer memory limits for large repos.
    const tarPath = join(tmpdir(), `codegraph-archive-${hash}-${Date.now()}.tar`);
    
    await exec(
      "git",
      ["archive", "--format=tar", "-o", tarPath, hash],
      { cwd: repoDir }
    );
    
    await exec("tar", ["-xf", tarPath], { cwd: tempDir });
    
    // Cleanup the tarball immediately after extraction
    await rm(tarPath, { force: true }).catch(() => {});
    
    return {
      hash,
      dir: tempDir,
      cleanup: async () => {
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch (e) {
          console.warn(`Failed to cleanup snapshot dir ${tempDir}`, e);
        }
      }
    };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to load snapshot for hash ${hash}: ${(err as Error).message}`);
  }
}
