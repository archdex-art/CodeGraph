import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);

export function redactCredentials(s: string): string {
  return s.replace(/:\/\/[^\s@/]+@/g, "://");
}

/**
 * Clone a public git repo. With no `destDir`, clones into a disposable temp
 * dir (single-branch, depth 1 — fastest path for one-shot indexing/fix
 * sandboxes; caller must rm it). With `destDir`, clones into that exact path
 * — used for the editor's persistent workspace, so it fetches all branches
 * (bounded depth) to support real branch switching + history.
 */
export async function cloneRepo(url: string, destDir?: string): Promise<string> {
  // Allows an optional `user:token@` userinfo component — used for
  // authenticated clones (see gitops.withToken); the token itself is never
  // logged or persisted by this function, only passed through to `git clone`'s argv.
  if (!/^https?:\/\/(?:[^@/]+@)?[\w.-]+\/[\w./~-]+/.test(url)) {
    throw new Error("Invalid repository URL. Use a public https git URL.");
  }
  const dir = destDir ?? mkdtempSync(path.join(tmpdir(), "cg-"));
  if (destDir) mkdirSync(path.dirname(destDir), { recursive: true });
  const args = destDir
    ? ["clone", "--depth", "50", url, dir]
    : ["clone", "--depth", "1", "--single-branch", url, dir];
  try {
    await exec("git", args, {
      timeout: Number(process.env.CG_CLONE_TIMEOUT_MS) || 90_000,
      maxBuffer: 1024 * 1024 * 16,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    if (e instanceof Error) {
      e.message = redactCredentials(e.message);
      const withCmd = e as Error & { cmd?: string; stderr?: string };
      if (typeof withCmd.cmd === "string") withCmd.cmd = redactCredentials(withCmd.cmd);
      if (typeof withCmd.stderr === "string") withCmd.stderr = redactCredentials(withCmd.stderr);
    }
    throw e;
  }
  return dir;
}

/** Validate and resolve a local folder path for indexing (no clone). */
export function resolveLocalDir(inputPath: string): string {
  const resolved = path.resolve(inputPath.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}
