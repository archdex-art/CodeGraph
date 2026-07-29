import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@codegraph/observability";

export interface LoadedSnapshot {
  hash: string;
  dir: string; // Temporary directory containing the exact state of the repo
  cleanup: () => Promise<void>;
}

/**
 * Loads repository contents for any commit into an isolated temporary directory
 * without modifying the user's working tree.
 *
 * `git archive` is piped directly into `tar -x`'s stdin rather than round-
 * tripping through an intermediate .tar file on disk — one less full
 * write-then-read of the archive, which matters on slower/network-attached
 * storage (e.g. a hosted platform's persistent disk) where this function
 * runs once per Timeline snapshot generated.
 */
export async function loadSnapshot(repoDir: string, hash: string): Promise<LoadedSnapshot> {
  const tempDir = await mkdtemp(join(tmpdir(), `codegraph-snapshot-${hash}-`));

  try {
    await new Promise<void>((resolve, reject) => {
      const archive = spawn("git", ["archive", "--format=tar", hash], { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
      const extract = spawn("tar", ["-x"], { cwd: tempDir, stdio: ["pipe", "ignore", "pipe"] });

      let archiveErr = "";
      let extractErr = "";
      archive.stderr.on("data", (d) => { archiveErr += d; });
      extract.stderr.on("data", (d) => { extractErr += d; });
      // If `extract` dies first, writes to its stdin raise EPIPE on the
      // source stream; without a listener that's an unhandled 'error' that
      // crashes the whole process. The close handlers below already surface
      // the real failure via exit codes, so these are just crash guards.
      archive.stdout.on("error", () => {});
      extract.stdin.on("error", () => {});
      archive.stdout.pipe(extract.stdin);

      let archiveExit: number | null = null;
      let extractExit: number | null = null;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        archive.kill();
        extract.kill();
        reject(err);
      };
      const maybeResolve = () => {
        if (settled || archiveExit === null || extractExit === null) return;
        settled = true;
        if (archiveExit !== 0) reject(new Error(`git archive exited ${archiveExit}: ${archiveErr.trim()}`));
        else if (extractExit !== 0) reject(new Error(`tar exited ${extractExit}: ${extractErr.trim()}`));
        else resolve();
      };
      archive.on("error", fail);
      extract.on("error", fail);
      archive.on("close", (code) => { archiveExit = code; maybeResolve(); });
      extract.on("close", (code) => { extractExit = code; maybeResolve(); });
    });

    return {
      hash,
      dir: tempDir,
      cleanup: async () => {
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch (e) {
          logger.warn("Failed to cleanup snapshot dir", { err: e, dir: tempDir });
        }
      }
    };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to load snapshot for hash ${hash}: ${(err as Error).message}`);
  }
}
