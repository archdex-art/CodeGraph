import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXERS } from "./providers/fixers";
import type { FileEdit, FixScope } from "./types";

/**
 * Apply fix providers to a working tree (LLD §7.1).
 *
 * Extracted from `apps/web/src/lib/agents/executor.ts` so `apps/cli` and `apps/web` run the
 * SAME codemods. `no-cross-app-imports` forbids the CLI importing the web app, and a second
 * copy of this loop is a second set of answers to "which lines did we change and why" — the
 * provenance a `VerificationRecord` is built on.
 *
 * MUTATES the tree in place. The caller owns the tree's disposability: the web executor works
 * in a temp clone, the CLI works on a copy of the developer's checkout. Nothing here decides
 * that, because getting it wrong means editing someone's real source.
 */

/** What one file's rewrite consisted of. */
export interface FileChange {
  /** The file's lines BEFORE the rewrite. */
  readonly before: readonly string[];
  /**
   * Original 0-based line index -> replacement text, or null for a deletion.
   *
   * Returned rather than left for the caller to re-derive by diffing before/after. The apply
   * loop KNOWS exactly which lines it touched; recovering that by comparing two arrays means
   * guessing back information we just threw away, and guessing wrong produces a diff that
   * does not match the edits the record claims.
   */
  readonly edits: ReadonlyMap<number, string | null>;
}

export interface ApplyResult {
  readonly edits: readonly FileEdit[];
  /** rel path -> what changed in it. */
  readonly changed: ReadonlyMap<string, FileChange>;
}

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__", ".venv",
  "vendor", ".cache",
]);

/**
 * Files a codemod may read. Bounded so a repository with a huge vendored tree cannot stall.
 *
 * The listing is SORTED. Two reasons, and the second is the load-bearing one: the diff this
 * produces is ordered by the walk, so an unsorted walk emits the same patch with its files
 * shuffled between machines; and the walk is capped at `limit`, so past the cap filesystem
 * order would decide WHICH files a run even fixes. `codegraph fix` claims a deterministic
 * result for identical input, and a sort is what makes that claim true.
 */
export function walkCode(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Sub-directories go on the stack in REVERSE, so `pop()` descends in ascending name order.
    const dirs: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Symlinks are not followed: a repository can point one outside the tree, and a fixer
      // that follows it edits a file the caller never offered.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (CODE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
      if (out.length >= limit) break;
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]!);
  }
  return out;
}

/**
 * Resolve a repo-relative path and PROVE it stays inside the tree.
 *
 * `applyFixes` WRITES, so a path that escapes `work` writes to the host. `scope.file` reaches
 * here from a `findings` row — the indexer's own walk produced it, not a request body — so this
 * is defence in depth rather than a patched hole. It is here anyway for two reasons: a value
 * that travelled through storage has a longer provenance than the call that used it, and the
 * layering rule this package is exempted from (`raw-fs-only-in-io-packages`) exists precisely
 * because "path containment gets re-implemented slightly wrong". Implemented once, tested, and
 * named in the exemption.
 *
 * `path.resolve` normalises `..` before the check, so `a/../../etc/passwd` is caught rather
 * than compared as text. The separator suffix stops `/work` matching `/workspace-evil`.
 */
function containedPath(work: string, rel: string): string | null {
  const root = path.resolve(work);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export function applyFixes(work: string, scope?: FixScope): ApplyResult {
  // A scoped run reads ONE file. Not an optimisation — reading the rest is what produced the
  // 27-file diff for a one-line finding (review C1).
  let files: string[];
  if (scope?.file !== undefined) {
    const abs = containedPath(work, scope.file);
    // A path that escapes the tree yields NO files rather than throwing: the caller asked to
    // fix a finding whose file is not in this tree, which is an empty result, not a crash.
    files = abs !== null && existsSync(abs) ? [abs] : [];
  } else {
    files = walkCode(work);
  }

  const allEdits: FileEdit[] = [];
  const changed = new Map<string, FileChange>();

  for (const full of files) {
    const rel = path.relative(work, full).split(path.sep).join("/");
    const ext = path.extname(full).toLowerCase();
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (lstatSync(full).isSymbolicLink()) continue;
    const original = text.split("\n");

    // Every fixer runs against the PRISTINE original lines, never chained, so each fixer's
    // reported `line` stays valid for diffing. Chaining would shift a later fixer's line
    // numbers by however many lines an earlier one deleted.
    const merged = new Map<number, string | null>();
    const fileEdits: FileEdit[] = [];
    const applicable = scope?.fixerIds
      ? FIXERS.filter((f) => scope.fixerIds!.includes(f.id))
      : FIXERS;

    for (const fx of applicable) {
      const res = fx.apply({ rel, ext, lines: original });
      for (const e of res.edits) {
        const idx = e.line - 1;
        // First fixer to claim a line wins, deterministically by FIXERS order. Two fixers
        // rewriting one line would otherwise produce an edit neither of them described.
        if (merged.has(idx)) continue;
        merged.set(idx, e.after);
        fileEdits.push(e);
      }
    }

    if (fileEdits.length === 0) continue;

    const finalLines: string[] = [];
    for (let i = 0; i < original.length; i++) {
      if (!merged.has(i)) {
        finalLines.push(original[i]!);
        continue;
      }
      const after = merged.get(i)!;
      // null = deletion, so the line is dropped entirely.
      if (after !== null) finalLines.push(after);
    }
    writeFileSync(full, finalLines.join("\n"), "utf8");
    allEdits.push(...fileEdits);
    changed.set(rel, { before: original, edits: merged });
  }

  return { edits: allEdits, changed };
}
