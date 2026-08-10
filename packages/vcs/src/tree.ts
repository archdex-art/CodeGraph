import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { childEnv } from "@codegraph/config";

/**
 * Reading a repository's files out of git, without a working tree.
 *
 * WHY THIS EXISTS
 *
 * Analysis materialised every file on disk and then read almost none of them. Measured on
 * `microsoft/TypeScript`:
 *
 *   git objects at --depth 50, --no-checkout   41 MB   11.7s
 *   the same clone, checked out               655 MB   +4.8s
 *
 * 614 MB of that is written so a walker can `stat` it, decide it is over the size cap or has
 * no language mapping, and discard it. `git ls-tree -r -l` answers the same questions -
 * which paths are tracked, and how big each one is - in **0.1s for 81,368 entries**, without
 * touching the filesystem, and hands back the object id needed to read the ones that survive.
 *
 * THE TRAP THIS AVOIDS
 *
 * The obvious version of this is a blobless clone (`--filter=blob:none`) and reading blobs on
 * demand. Measured: `git cat-file` on a blobless clone fetches each missing blob over the
 * network one round trip at a time, and reading 39,334 of them **exceeded 900 seconds** before
 * being killed. So the pack must arrive complete - a normal shallow clone - and the saving
 * comes from never checking it out, not from downloading less.
 */

/** One tracked file, as git describes it, before anything has been read. */
export interface TreeEntry {
  /** Repo-relative POSIX path, exactly as git records it. */
  readonly path: string;
  /** Blob object id. Content-addressed, so it doubles as a cache key. */
  readonly oid: string;
  /** Bytes. Available before the content is read, so a size cap costs nothing. */
  readonly size: number;
}

/**
 * `git ls-tree -r -l HEAD`, parsed.
 *
 * Returns null when `root` is not a git checkout or has no commit yet, so the caller can fall
 * back to walking the filesystem. An empty array means a real repository with no tracked
 * files, which is a different fact and is reported as one.
 *
 * Tracked files only, which is the gitignore-correct set for free: the separate
 * `git ls-files` pass the walker needed for the same answer is redundant here.
 */
export function gitTreeFiles(root: string): TreeEntry[] | null {
  const res = spawnSync("git", ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"], {
    cwd: root,
    encoding: "buffer",
    // A big monorepo's listing is a few MB of text; the default 1 MB would truncate it into a
    // silently short file list, which is the worst possible failure for a coverage number.
    maxBuffer: 256 * 1024 * 1024,
    env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
  });
  if (res.status !== 0 || !res.stdout) return null;

  const out: TreeEntry[] = [];
  /*
   * `-z` because paths may contain anything a filesystem allows, including newlines. Without
   * it git C-quotes unusual names and the parser has to unescape them - a second encoding to
   * get wrong. NUL-separated records cannot be ambiguous.
   */
  for (const record of res.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    // `<mode> SP <type> SP <oid> SP <size> TAB <path>`; size is `-` for non-blobs.
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    if (meta.length < 4 || meta[1] !== "blob") continue; // submodules and trees are not files
    const size = Number(meta[3]);
    if (!Number.isFinite(size)) continue;
    out.push({ path: record.slice(tab + 1), oid: meta[2]!, size });
  }
  return out;
}

/**
 * Read blobs by object id, in one `git cat-file --batch`.
 *
 * One subprocess for the whole set, not one per file: 39,334 blobs read in **0.23s** on the
 * measurement above. The batch protocol is length-prefixed, so this parses bytes rather than
 * splitting on newlines - a source file containing the header shape would otherwise desync
 * the stream for every file after it.
 *
 * Binary content is returned as-is; the caller decides what is text. A blob git cannot find
 * is skipped rather than throwing, because one unreadable object should not fail an index.
 */
export function readBlobs(root: string, oids: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (oids.length === 0) return found;

  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: oids.join("\n") + "\n",
    // The blobs themselves. Callers cap per-file size before getting here, but the SUM is
    // still large, so this is generous and deliberate.
    maxBuffer: 1024 * 1024 * 1024,
    env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
  });
  if (res.status !== 0 || !res.stdout) return found;

  const buf = res.stdout as unknown as Buffer;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.toString("utf8", at, nl);
    at = nl + 1;
    // `<oid> SP <type> SP <size>` or `<name> SP missing`.
    const parts = header.split(" ");
    if (parts.length < 3 || parts[1] !== "blob") continue; // includes the `missing` form
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) break; // the stream is no longer trustworthy; stop cleanly
    found.set(parts[0]!, buf.toString("utf8", at, at + size));
    at += size + 1; // git writes a trailing newline after each object
  }
  return found;
}

/**
 * Materialise the working tree for a repository cloned with `--no-checkout`.
 *
 * Analysis does not need this; the EDITOR does, and so does the remediation sandbox, because
 * both hand real paths to tools that open real files. Paying for the checkout at that moment
 * rather than at index time is the whole saving: a reader who never opens the editor never
 * writes the 614 MB.
 *
 * Idempotent, and safe on a tree that is already checked out - `git checkout HEAD -- .` will
 * not discard files git does not track, and callers use `hasWorkingTree` to skip it entirely.
 */
export function materialiseWorkingTree(root: string): void {
  execFileSync("git", ["checkout", "HEAD", "--", "."], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
  });
}

/**
 * Materialise only the paths matching `pathspecs`.
 *
 * Dependency and advisory analysis read manifests (`package.json`, lockfiles,
 * `requirements.txt`) straight off disk. Those are a handful of small files, so they are
 * checked out even in the no-working-tree path rather than rewriting two analysers around a
 * blob reader for a rounding error's worth of bytes.
 */
export function materialisePaths(root: string, pathspecs: readonly string[]): void {
  if (pathspecs.length === 0) return;
  /*
   * Filtered against the tree first, because `git checkout HEAD -- a b` fails the WHOLE
   * command when any one pathspec matches nothing - and most repositories have no
   * `requirements.txt`. Passing the full list checked out none of them, silently, which read
   * downstream as "this project declares no dependencies".
   */
  const tracked = new Set((gitTreeFiles(root) ?? []).map((e) => e.path));
  const present = pathspecs.filter((p) => tracked.has(p));
  if (present.length === 0) return;
  spawnSync("git", ["checkout", "HEAD", "--", ...present], {
    cwd: root,
    encoding: "utf8",
    env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
  });
}

/**
 * True when `root` has files checked out, as opposed to only a `.git` directory.
 *
 * Probes the COMMIT, not the index. After `git clone --no-checkout` the index is EMPTY - not
 * populated-but-unwritten, as one might assume - so `git ls-files` reports nothing and a
 * probe built on it concludes "no tracked files, therefore nothing to materialise", which is
 * exactly backwards. `ls-tree` reads HEAD and is unaffected.
 */
export function hasWorkingTree(root: string): boolean {
  const entries = gitTreeFiles(root);
  if (entries === null) return true; // not a git repo: whatever is there IS the tree
  if (entries.length === 0) return true; // nothing tracked; nothing to materialise
  return existsSync(path.join(root, entries[0]!.path));
}
