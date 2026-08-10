import { execFile, execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv, config } from "@codegraph/config";
import { redactError } from "./redact";
import { gitTreeFiles, materialisePaths } from "./tree";

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
 * Repo-relative paths of the manifests analysis reads off disk, from the git tree.
 *
 * Basename match rather than a glob, because the analysers look for these names at any depth
 * in a monorepo. Bounded by the same reasoning as everything else that reads an attacker's
 * repository: a tree with fifty thousand `package.json` files is a denial of service, not a
 * monorepo, and the dependency analyser caps itself at 128 manifests anyway.
 */
const MANIFEST_NAMES = new Set(["package.json", "package-lock.json"]);
const MAX_MATERIALISED_MANIFESTS = 256;

function manifestPaths(dir: string): string[] {
  const out: string[] = [];
  for (const entry of gitTreeFiles(dir) ?? []) {
    const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    if (!MANIFEST_NAMES.has(base)) continue;
    out.push(entry.path);
    if (out.length >= MAX_MATERIALISED_MANIFESTS) break;
  }
  return out;
}
/**
 * Compare two remote URLs for "same repository".
 *
 * Credentials, a trailing `.git` and a trailing slash all vary between how a user typed the
 * URL and what git recorded, and none of them changes which repository is meant.
 */
function sameRemote(a: string, b: string): boolean {
  const norm = (u: string) =>
    u.trim().toLowerCase().replace(/^https?:\/\/[^@/]*@/, "https://").replace(/\/+$/, "").replace(/\.git$/, "");
  return norm(a) === norm(b);
}

/**
 * Bring an existing persistent workspace up to date, without destroying work in it.
 *
 * WHY THIS EXISTS. The workspace directory is named by REPO ID. Re-indexing used to mint a new
 * id and therefore a new empty directory, so `git clone` always had somewhere clean to land.
 * Once repositories gained a stable identity - so that re-indexing updates a row instead of
 * inserting a duplicate - the id stopped changing, the directory was already populated, and
 * every re-index of a git repository died on
 *
 *     fatal: destination path '...' already exists and is not an empty directory
 *
 * which surfaced to the user as "Indexing did not complete." on the action the product itself
 * tells them to take.
 *
 * WHY IT DOES NOT HARD-RESET. This is the same tree the built-in editor commits from. A
 * `reset --hard` here would silently delete someone's uncommitted edits and their local
 * commits. So the update is strictly non-destructive: fetch, then fast-forward ONLY if git
 * agrees it can be done without a merge. A dirty or diverged tree keeps what it has and is
 * analysed as it stands, which is also what indexing a local folder does.
 *
 * Returns false when the directory cannot be used as this repository's workspace at all - not
 * a git repo, or a clone of something else - and the caller replaces it.
 */
export async function refreshWorkspace(dir: string, url: string): Promise<boolean> {
  // A fast path, not a correctness guard: `git remote get-url` below fails on a non-repository
  // and reaches the same answer. This just avoids spawning git for the common leftover-tree
  // case. Mutation testing confirms removing it changes no result.
  if (!existsSync(path.join(dir, ".git"))) return false;
  const env = childEnv({ GIT_TERMINAL_PROMPT: "0" });
  const opts = { cwd: dir, timeout: config.cloneTimeoutMs, maxBuffer: 1024 * 1024 * 16, env } as const;

  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], opts);
    if (!sameRemote(stdout, url)) return false;
  } catch {
    return false; // no origin, or not a repository git will talk about
  }

  /*
   * Best-effort from here. A workspace that is present and on the right remote is already
   * usable; failing the whole index because the network was down would be a worse answer than
   * analysing the tree we have. Both steps are individually allowed to fail.
   */
  try {
    await exec("git", ["-c", "http.followRedirects=false", "fetch", "--depth", "50", "origin", "HEAD"], opts);
    await exec("git", ["merge", "--ff-only", "FETCH_HEAD"], opts);
  } catch {
    // Diverged, dirty, detached or offline. The working tree stands as the thing to analyse.
  }
  return true;
}

/**
 * How long the process tree gets between SIGTERM and SIGKILL.
 *
 * 2 s is generous for git's own cleanup (it unlinks `index.lock` and the partial pack on
 * SIGTERM) and short enough that the caller's `rmSync` is never racing a live writer.
 */
const KILL_GRACE_MS = 2_000;

/**
 * Bytes of stderr kept for diagnosis. git's `fatal:` line is the LAST thing it writes, so
 * a tail keeps the whole diagnosis while bounding what `--progress` can accumulate — the
 * old `maxBuffer: 16 MB` bounded it by killing the clone instead.
 */
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * git's progress lines, e.g. `Receiving objects:  47% (12345/26000), 340.00 MiB | 2.30 MiB/s`.
 *
 * Phase, percent and bytes-so-far are everything a stall report needs. The instantaneous
 * RATE is deliberately dropped: at the moment a transfer stalls it is always about zero, so
 * quoting it reads as the diagnosis when it is only the symptom.
 */
const PROGRESS_RE = /([A-Za-z][A-Za-z ]*?):\s+(\d+)%(?:[^,\r\n]*,\s+([\d.]+ [KMGT]?i?B))?/g;

/** `Receiving objects 47%, 340.00 MiB`, or `previous` when this chunk said nothing parseable. */
function progressSummary(chunk: string, previous: string): string {
  let summary = previous;
  // Progress is carriage-return separated, so one chunk routinely carries several
  // updates; the LAST one in it is the current state.
  for (const m of chunk.matchAll(PROGRESS_RE)) {
    const [, phase, percent, size] = m;
    if (phase === undefined || percent === undefined) continue;
    summary = size ? `${phase} ${percent}%, ${size}` : `${phase} ${percent}%`;
  }
  return summary;
}

/**
 * Stop a git process TREE, and mean it.
 *
 * `git clone` is not one process: `git-remote-https` runs the transfer and `index-pack`
 * writes the objects. Signalling only the parent leaves those children holding the socket
 * and writing into a directory the caller is about to delete — which is the difference
 * between "the clone was stopped" and "the clone's parent was stopped".
 *
 * SIGTERM first so git can unlink its lockfile, SIGKILL after a grace because the transport
 * can be blocked in a read on a dead socket, where a queued SIGTERM is never handled.
 */
function killTree(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) return; // spawn failed; there is nothing to signal
  const send = (signal: NodeJS.Signals): void => {
    try {
      // Negative pid = the whole process GROUP, which `detached` gave the child.
      process.kill(-pid, signal);
    } catch {
      // ESRCH — the group is already gone — or a platform without process groups.
      // Try the single process before concluding nothing needs killing.
      try {
        child.kill(signal);
      } catch {
        /* already reaped */
      }
    }
  };
  send("SIGTERM");
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) send("SIGKILL");
  }, KILL_GRACE_MS);
  // Never hold the event loop open for a process that already died.
  escalate.unref();
  child.once("close", () => clearTimeout(escalate));
}

export interface CloneLimits {
  /** Killed when NO byte of output has appeared for this long. */
  readonly stallMs: number;
  /** Killed unconditionally after this long, however lively the output looks. */
  readonly maxMs: number;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Run a clone under a STALL timer rather than a stopwatch.
 *
 * WHY THIS REPLACED `execFile`'s `timeout`. The clone used to run with
 * `timeout: config.cloneTimeoutMs` — a flat 90 s wall clock. That kills a clone which is
 * downloading steadily at 89 s, and whether it fires depends on the operator's bandwidth
 * rather than on anything about the repository: `microsoft/TypeScript` was measured at
 * 15.9 s on a fast link, and the identical clone on a slow link died mid-transfer having
 * made continuous progress throughout. The user saw "The clone took too long and was
 * stopped." on a repository that was working perfectly.
 *
 * So the timer measures SILENCE. `--progress` makes git write progress to stderr roughly
 * every 100 ms even with no TTY attached, so any byte of output — on either stream —
 * rearms the window, and only a transfer that has genuinely stopped moving is killed.
 * `maxMs` is the second, much larger backstop for what a stall timer structurally cannot
 * see: a remote dribbling one byte a second rearms the window forever and is never going
 * to finish.
 *
 * Exported because it is the unit worth testing offline (`tests/clone-stall.test.ts` runs
 * fake commands through it rather than a real network clone).
 */
export async function runBoundedClone(
  command: string,
  args: readonly string[],
  limits: CloneLimits,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      // Its own process group, so `killTree` can reach git's transport helpers.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: limits.env,
    });

    let progress = "";
    let stderrTail = "";
    let aborted: Error | undefined;
    let settled = false;
    let stall: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;

    const ceiling = setTimeout(
      () => abort(`Clone exceeded the ${Math.round(limits.maxMs / 1000)}s limit`),
      limits.maxMs,
    );

    function settle(e: Error | undefined): void {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      clearTimeout(ceiling);
      clearTimeout(hardStop);
      if (e) reject(e);
      else resolve();
    }

    /**
     * The failure message names the PHASE and nothing else.
     *
     * It reaches a browser through `classifyIndexFailure` in `apps/web/src/lib/store.ts`,
     * and the version of this path that used `execFile` shipped the absolute workspace
     * path, the workspace UUID and the full `git -c …` command line to anonymous visitors
     * (F023). So: no argv, no destination directory, no URL.
     */
    function abort(reason: string): void {
      if (aborted) return;
      aborted = new Error(
        `${reason}${progress ? ` (last: ${progress})` : ""}. The repository may be very large or the network slow.`,
      );
      clearTimeout(stall);
      clearTimeout(ceiling);
      killTree(child);
      /*
       * Reject only once the tree is actually GONE, so a caller that removes the
       * destination directory on failure cannot race a git still writing into it.
       * SIGKILL guarantees that exit, so this timer only covers a process wedged in an
       * uninterruptible syscall — where reporting the stall still beats hanging.
       */
      hardStop = setTimeout(() => settle(aborted), KILL_GRACE_MS * 3);
    }

    function rearm(): void {
      if (aborted) return;
      clearTimeout(stall);
      stall = setTimeout(
        () => abort(`Clone stalled: no progress for ${Math.round(limits.stallMs / 1000)}s`),
        limits.stallMs,
      );
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      progress = progressSummary(text, progress);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
      rearm();
    });
    // A clone writes nothing useful to stdout, but a byte on it is still proof of life.
    child.stdout?.on("data", () => rearm());

    child.on("error", (e) => settle(aborted ?? e));

    // `close`, not `exit`: stderr must be fully drained before it is used as evidence.
    child.on("close", (code, signal) => {
      if (aborted) return settle(aborted);
      if (code === 0) return settle(undefined);
      /*
       * Shaped like `execFile`'s rejection deliberately. `classifyIndexFailure` reads
       * `.message` AND `.stderr`, and git's actual diagnosis ("repository not found",
       * "terminal prompts disabled", "unable to update url base from redirection") is in
       * stderr — dropping the field would collapse every git-level failure into the
       * `unknown` fallback. What is NOT reproduced is `execFile`'s
       * "Command failed: git -c …" message prefix, which is what leaked the argv.
       */
      settle(
        Object.assign(new Error(`git exited with ${signal ? `signal ${signal}` : `code ${code}`}`), {
          stderr: stderrTail,
          code,
        }),
      );
    });

    rearm();
  });
}

/**
 * Clone a public git repo. With no `destDir`, clones into a disposable temp dir (depth 1 —
 * fastest path for one-shot indexing/fix sandboxes; caller must rm it). With `destDir`,
 * clones into that exact path at depth 50 — the editor's persistent workspace, whose
 * timeline and ownership analysis need history.
 *
 * Both are `--single-branch`. See the argv below for why, and `listBranches` /
 * `checkoutBranch` in `git.ts` for how the editor still reaches the other branches.
 */
export async function cloneRepo(url: string, destDir?: string): Promise<string> {
  // Allows an optional `user:token@` userinfo component — used for authenticated
  // clones (see `withToken`). The token is passed through to `git clone`'s argv and is
  // never logged; it IS written to `.git/config` by git itself, which is why the stored
  // remote is rewritten without it below.
  if (!/^https?:\/\/(?:[^@/]+@)?[\w.-]+\/[\w./~-]+/.test(url)) {
    throw new Error("Invalid repository URL. Use a public https git URL.");
  }
  const dir = destDir ?? mkdtempSync(path.join(tmpdir(), "cg-"));
  if (destDir) mkdirSync(path.dirname(destDir), { recursive: true });

  /*
   * A persistent workspace that is already there is UPDATED, not re-cloned. See
   * `refreshWorkspace`: the directory is keyed by repo id, and ids are now stable across
   * re-indexes, so this is the ordinary path rather than the exceptional one.
   *
   * Anything else occupying the path - an aborted clone that left a partial tree, or a clone
   * of a different repository under a recycled id - is removed, because `git clone` will not
   * write into a non-empty directory and the alternative is failing every re-index.
   */
  if (destDir && existsSync(destDir)) {
    if (await refreshWorkspace(destDir, url)) return destDir;
    rmSync(destDir, { recursive: true, force: true });
  }
  /**
   * `http.followRedirects=false` is the SSRF guard's second half.
   *
   * `isPublicHttpUrl` vets the URL the user submitted, and nothing after that constrains
   * where git actually connects: git's default (`initial`) follows a redirect on the first
   * request, so a 302 from an attacker's public host to `169.254.169.254` or an RFC1918
   * address turns a validated URL into a server-side request the guard never saw.
   *
   * The cost is honest and small: cloning a RENAMED repository by its old URL now fails with
   * git's own "repository moved" error instead of silently following. For an internet-facing
   * service that clones URLs strangers supply, an explicit error the user can act on beats an
   * unvalidated request to the operator's internal network.
   */
  /*
   * `--single-branch` on BOTH paths.
   *
   * The persistent-workspace clone omitted it, so `--depth 50` meant 50 commits on EVERY
   * branch: on a repository with hundreds of branches that transfer dominates the clone,
   * and nothing read the extra refs. Ownership analysis and the timeline read the
   * checked-out branch's history only. Branch switching in the editor is a real feature and
   * still works — `listBranches` enumerates the remote's heads with `ls-remote` and
   * `checkoutBranch` fetches a branch on demand — which is a ref advertisement and one
   * branch, instead of every branch on every index.
   *
   * `--progress` because git suppresses progress when stderr is not a TTY, and progress on
   * stderr is exactly what `runBoundedClone`'s stall timer measures.
   */
  const args = [
    "-c",
    "http.followRedirects=false",
    "clone",
    "--progress",
    "--single-branch",
    /*
     * NO CHECKOUT.
     *
     * Analysis reads the repository out of git (`gitTreeFiles` / `readBlobs`), so writing the
     * working tree here is pure cost. Measured on `microsoft/TypeScript`: 41 MB of objects
     * become 655 MB once checked out, and the walk then reads those files once and discards
     * most of them. The tree is materialised by `requireWorkspace` the first time a route
     * wants real paths — the editor, search, git status — so a reader who only looks at the
     * graph never pays for it.
     *
     * The disposable temp clone (`destDir` unset) keeps its checkout: it is used by the fix
     * sandbox, which runs the developer's own build and tests and therefore needs real files
     * immediately. Skipping the checkout there would only move the cost, not remove it.
     */
    ...(destDir ? ["--no-checkout"] : []),
    "--depth",
    destDir ? "50" : "1",
    url,
    dir,
  ];
  try {
    await runBoundedClone("git", args, {
      stallMs: config.cloneStallMs,
      maxMs: config.cloneMaxMs,
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

  /**
   * The few files the dependency analysers read straight off disk.
   *
   * `advisories.ts` walks for `package.json` with `readdirSync` and reads `package-lock.json`
   * with `readFileSync`, so a repository with no working tree would look like one that
   * declares no dependencies — a wrong answer, and a quiet one. Rather than rewrite two
   * analysers around a blob reader for a handful of small files, those files (and only those)
   * are checked out.
   *
   * Deliberately narrow. Widening this list is how `--no-checkout` turns back into a
   * checkout: anything added here is paid for by every index of every repository.
   */
  if (destDir) materialisePaths(dir, manifestPaths(dir));

  /**
   * Strip the credential git just wrote to `<dir>/.git/config`.
   *
   * `git clone https://x-access-token:<PAT>@github.com/o/r` records the full URL, token
   * included, as `remote.origin.url`. For the editor's PERSISTENT workspace that left a live
   * `repo`-scoped GitHub token in plaintext on the data disk for as long as the workspace
   * existed — readable by anything that could read a file in it, and by any later bug that
   * could. Nothing needs it there: `push` and `pull` both take a credentialed remote per
   * invocation.
   *
   * Best-effort. A clone that succeeded must not be thrown away because a cosmetic rewrite
   * failed, and the fallback state is exactly today's behaviour rather than something worse.
   */
  const stripped = url.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  if (stripped !== url) {
    try {
      await exec("git", ["-C", dir, "remote", "set-url", "origin", stripped], {
        timeout: 10_000,
        env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
      });
    } catch (e) {
      throw redactError(e);
    }
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

/**
 * The repo-relative paths git would NOT ignore, or null when `root` is not a git checkout.
 *
 * WHY THE INDEXER NEEDS THIS. The walk's own skip list is a fixed set of directory names —
 * `node_modules`, `dist`, `.next` and a handful more — so anything a project ignores for its
 * own reasons is analysed as source. Measured on THIS repository: `apps/web/data/` is
 * gitignored (it holds the app's SQLite database and its cached timeline snapshots) and the
 * indexer read 54 JSON files totalling 581,639 lines out of it — against 29,368 lines of
 * actual TypeScript. `apps` was reported as a JSON module, coloured as one, and every LOC
 * figure and language share for it was mostly the tool's own database. The `.gitignore` entry
 * even carries a comment about the same files having once been committed by accident.
 *
 * Asking GIT rather than parsing `.gitignore`: the format has negations, anchoring, `**`,
 * per-directory files, `.git/info/exclude` and the global core.excludesFile, and a
 * half-implementation is a new and quieter way to be wrong about which files exist. One
 * subprocess gets the exact answer.
 *
 * `--cached --others --exclude-standard` is "tracked, plus untracked-and-not-ignored" — which
 * is precisely the set a reader would call the project's own files. Paths come back relative
 * to `root` even when it is a subdirectory of the checkout, which is the frame the walk uses.
 *
 * NULL, not an empty set, when there is no git here. A plain directory is a supported input
 * (`CG_ALLOW_LOCAL_ACCESS`), and an empty set would mean "analyse nothing".
 */
export function listNonIgnoredFiles(root: string): Set<string> | null {
  try {
    const out = execSync(
      "git ls-files --cached --others --exclude-standard -z",
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // A very large monorepo listing is still only paths; this is the ceiling past which
        // the answer is not worth the memory, and the caller degrades to no filtering.
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    // `-z` because a filename may contain a newline, and a split on "\n" would invent two
    // paths that do not exist and drop the one that does.
    const paths = out.split("\0").filter(Boolean);
    // No output is a real answer for an empty repository, but it is indistinguishable from a
    // git that printed nothing for a reason we did not anticipate. Treating it as "no
    // filtering" risks analysing junk; treating it as "nothing to analyse" loses the repo
    // entirely. The first failure is recoverable and visible, so it wins.
    if (paths.length === 0) return null;
    return new Set(paths);
  } catch {
    return null;
  }
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
