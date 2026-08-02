import { execFile, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv, config } from "@codegraph/config";
import { redactError } from "./redact";

/**
 * Acquiring a working tree to analyse, and reading history from it.
 *
 * Moved here from `apps/web/src/lib/indexer.ts` (LLD §13.2). This is not a new
 * seam: `indexer.ts` was calling `git clone` and `git log` through
 * `child_process` directly, which contradicts LLD §10.2's "only `vcs` shells
 * out". The move closes that P1 gap.
 *
 * It also had to happen before `apps/worker` could exist at all — the worker
 * cannot import `apps/web` (`no-cross-app-imports`), and it needs to acquire a
 * tree before it can index one. See HLD §17's P2 note.
 */

const exec = promisify(execFile);

/**
 * Clone a public git repo. With no `destDir`, clones into a disposable temp dir
 * (single-branch, depth 1 — fastest path for one-shot indexing/fix sandboxes;
 * caller must rm it). With `destDir`, clones into that exact path — used for the
 * editor's persistent workspace, so it fetches all branches (bounded depth) to
 * support real branch switching + history.
 */
export async function cloneRepo(url: string, destDir?: string): Promise<string> {
  // Allows an optional `user:token@` userinfo component — used for authenticated
  // clones (see `withToken`); the token itself is never logged or persisted by
  // this function, only passed through to `git clone`'s argv.
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
      timeout: config.cloneTimeoutMs,
      maxBuffer: 1024 * 1024 * 16,
      // childEnv, not a config value: `git` needs the whole inherited environment
      // (PATH, HOME, SSH_AUTH_SOCK, proxy vars) to run at all.
      // GIT_TERMINAL_PROMPT=0 stops it blocking forever on a credential prompt.
      env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
    });
  } catch (e) {
    // Same redaction as every other git error path, from the one place that owns
    // it (LLD §10.2). redactError also covers `.stdout`.
    throw redactError(e);
  }
  return dir;
}

/** Validate and resolve a local folder path for indexing (no clone). */
export function resolveLocalDir(inputPath: string): string {
  const resolved = path.resolve(inputPath.replace(/^~(?=$|\/)/, config.homeDir ?? "~"));
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

/** Remove a disposable clone. Never throws — callers use it in `finally`. */
export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort. A leaked temp dir is a disk-space problem, not a correctness
    // one, and throwing here would mask the error the caller is already handling.
  }
}

/**
 * Recent commit counts per file, for the churn signal the scorer and judge use.
 *
 * Six months is the window v1 used and is carried forward verbatim; changing it
 * would move every score that weights churn, which P2 may not do.
 *
 * Returns an empty map rather than throwing when the directory is not a git repo
 * or `git` is unavailable — churn is an enrichment, and a local folder that is
 * not version-controlled is a supported input, not an error.
 */
export function churnByFile(root: string): Map<string, number> {
  const churn = new Map<string, number>();
  try {
    const out = execSync(`git log --since="6.months.ago" --name-only --format=""`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const f = line.trim();
      if (f) churn.set(f, (churn.get(f) || 0) + 1);
    }
  } catch {
    // Not a git repo, or git not installed.
  }
  return churn;
}
