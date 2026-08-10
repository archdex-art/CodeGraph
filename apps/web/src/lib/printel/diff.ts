/**
 * Unified-diff parsing for PR intelligence.
 *
 * The input is a REAL diff and it comes from one of two places: `git diff base..head` over a
 * workspace, or a GitHub pull request's `.diff` payload. Both are the same grammar, so this
 * module is the single entry point and nothing downstream knows which source it came from.
 *
 * THE HUNK GRAMMAR IS NOT MINE. `packages/vcs/src/ownership.ts` already parses `@@` headers
 * (`parseGitLogHunks`) and that function's comment records the one subtlety that makes the
 * difference between a correct parser and an exploitable one; this module reuses its approach
 * line for line rather than inventing a second reading of the format. It cannot CALL it: that
 * function consumes `git log -p --unified=0` — record separators, commit headers, no context
 * lines, deletions discarded — and this consumes a bare diff with context and needs the
 * add/delete/rename status that a log pass throws away. `pr-intel.test.ts` pins the two
 * against the same payload so the shared grammar cannot drift silently.
 *
 * THE SUBTLETY, restated because it is a security property and not a parsing nicety. A file's
 * own content can look like diff metadata. With context lines present every content line is
 * prefixed by ` `, `+` or `-`, so `diff --git ` at column 0 is always git's. `+++` and `---`
 * are NOT safe that way: a removed line whose content is `-- b/x` is emitted as `--- b/x`, and
 * an added line whose content is `++ b/x` is emitted as `+++ b/x`. Both sit at column 0 and
 * both are indistinguishable from a header by shape alone. Position is what distinguishes
 * them: git emits its `---`/`+++` pair only BETWEEN `diff --git` and that file's first `@@`.
 * So once a hunk has started, `+++`/`---` stop being honoured until the next `diff --git`.
 * Without that flag a committed patch file reassigns every following hunk — and therefore
 * every changed symbol, endpoint and reviewer downstream — to a path of the author's choosing.
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  /** Repo-relative POSIX path in the POST-image. For a rename, the new path. */
  readonly path: string;
  readonly status: ChangeStatus;
  /**
   * Inclusive `[start, end]` line ranges in the POST-image, ascending.
   *
   * Always post-image, because the only thing that consumes them is an intersection against
   * symbol spans extracted from the CURRENT tree. A deleted file therefore has NO ranges —
   * there is no post-image to name lines in — and is handled downstream by path instead.
   * A mode-only change also has none, and is still reported: "this file changed" is true.
   */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

/** Identical to `HUNK_HEADER_RE` in `packages/vcs/src/ownership.ts`. Post-image side only. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Diff text this will read. 12 MiB is roughly a 100k-line change; past that the payload is a
 * vendored-tree import or a generated bundle, and parsing it costs more than the answer is
 * worth. The excess is dropped at a line boundary and the caller sees the files it did find.
 */
const MAX_DIFF_BYTES = 12 * 1024 * 1024;

/** Files carried out of one diff. A larger change is a rename sweep, not a reviewable PR. */
const MAX_FILES = 2_000;

/** Ranges kept per file. A regenerated lockfile produces tens of thousands of one-line hunks. */
const MAX_RANGES_PER_FILE = 2_000;

interface Pending {
  path: string | null;
  status: ChangeStatus;
  /** Path from the `diff --git a/X b/Y` line, used only when no `+++`/`---` pair appeared. */
  headerPath: string | null;
  ranges: Array<readonly [number, number]>;
  inHunks: boolean;
}

const PENDING_INITIAL: Pending = {
  path: null,
  status: "modified",
  headerPath: null,
  ranges: [],
  inHunks: false,
};

/**
 * Best-effort path from `diff --git a/X b/Y`, used ONLY for a file with no `+++`/`---` pair:
 * a binary file, or a pure mode/permission change. Ambiguous when the filename itself contains
 * `" b/"`, which is why it never overrides the unambiguous `+++` line when one exists.
 */
function headerTargetPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (!rest.startsWith("a/")) return null;
  const sep = rest.indexOf(" b/");
  if (sep === -1) return null;
  const target = rest.slice(sep + 3).trim();
  return target.length > 0 ? target : null;
}

/** `b/src/x.ts` → `src/x.ts`; `/dev/null` → null. Trailing tab-separated metadata dropped. */
function diffPath(raw: string): string | null {
  // git appends a tab and a timestamp under `--date`/`-U` combinations with some porcelains.
  const tab = raw.indexOf("\t");
  const value = (tab === -1 ? raw : raw.slice(0, tab)).trim();
  if (value === "" || value === "/dev/null") return null;
  // Quoted when the path holds a byte git will not print raw. The quoted form is a C string;
  // unescaping it here would be a second grammar, so the quotes are stripped and the escapes
  // left as written — a path this exotic is reported honestly-ish rather than dropped.
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return unquoted.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(raw: string): ChangedFile[] {
  const text = raw.length > MAX_DIFF_BYTES ? raw.slice(0, MAX_DIFF_BYTES) : raw;
  const out: ChangedFile[] = [];
  // Keyed by a path read out of the diff, i.e. by an attacker-authored string: a `Record`
  // here answers `"constructor"` with `Object.prototype.constructor`, which is truthy.
  const seen = new Set<string>();
  let cur: Pending = { ...PENDING_INITIAL, ranges: [] };

  const flush = (): void => {
    const path = cur.path ?? cur.headerPath;
    if (path !== null && out.length < MAX_FILES && !seen.has(path)) {
      seen.add(path);
      // A deleted file has no post-image; `@@ -1,20 +0,0 @@` names line 0 of nothing.
      const ranges = cur.status === "deleted" ? [] : cur.ranges;
      out.push({ path, status: cur.status, ranges });
    }
    cur = { ...PENDING_INITIAL, ranges: [] };
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur.headerPath = headerTargetPath(line);
      continue;
    }
    if (!cur.inHunks) {
      // These four markers cannot be spoofed by content: every content line carries a ` `,
      // `+` or `-` prefix, so column 0 of a content line is never `n`, `d` or `r`.
      if (line.startsWith("new file mode ")) {
        cur.status = "added";
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        cur.status = "deleted";
        continue;
      }
      if (line.startsWith("rename to ")) {
        cur.status = "renamed";
        // `rename to` carries the new path, and a pure rename has no `+++` line at all.
        cur.path = diffPath(line.slice("rename to ".length));
        continue;
      }
      if (line.startsWith("rename from ")) {
        cur.status = "renamed";
        continue;
      }
      if (line.startsWith("--- ")) {
        // `--- /dev/null` is the only unambiguous statement that the file is new. It does not
        // override an explicit `new file mode`, it confirms it.
        if (diffPath(line.slice(4)) === null) cur.status = "added";
        continue;
      }
      if (line.startsWith("+++ ")) {
        const target = diffPath(line.slice(4));
        if (target === null) cur.status = "deleted";
        else cur.path = target;
        continue;
      }
    }
    const m = HUNK_HEADER_RE.exec(line);
    if (!m) continue;
    // From here to the next `diff --git`, a `+++`/`---` at column 0 is file CONTENT.
    cur.inHunks = true;
    if (cur.ranges.length >= MAX_RANGES_PER_FILE) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
    if (count === 0) {
      // `+N,0` is a pure deletion: nothing exists at N in the post-image and the removal sits
      // between N and N+1. Attributed to max(N,1) — the symbol that LOST the code is the one
      // that contained the line above it. Same rule as `parseGitLogHunks`.
      const at = Math.max(1, start);
      cur.ranges.push([at, at]);
    } else {
      cur.ranges.push([start, start + count - 1]);
    }
  }
  flush();

  // Sorted rather than left in git's order: two callers diffing the same pair — one over a
  // workspace, one over a GitHub payload — must produce byte-identical analyses.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * `git diff --name-status` letter → status, for the path where the file list and the per-file
 * diffs are fetched separately (`getCommitDiffFiles` + `diffCommitsFile`). Static table, never
 * indexed by a repository-authored string, so a `Record` is safe here.
 */
const NAME_STATUS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added", // a copy has no prior history at the new path, so it reads as new code
  T: "modified", // typechange: symlink ↔ file
};

/** Unknown letters (U, X, and anything a future git adds) read as `modified`, never dropped. */
export function statusFromNameStatus(letter: string): ChangeStatus {
  return NAME_STATUS[letter.trim().charAt(0).toUpperCase()] ?? "modified";
}
