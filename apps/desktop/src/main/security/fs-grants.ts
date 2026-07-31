import * as path from "path";
import { realpathSync } from "fs";

/**
 * Path containment for IPC filesystem access.
 *
 * **The hole this closes.** `FileSystemService.readFile` passed `request.path` straight from an
 * IPC message to `fs.readFile`, and `writeFile` did the same. The IPC router gates those on the
 * coarse `fs:read` / `fs:write` permissions, which answer "may the renderer touch the disk at
 * all" - not "which files". Any renderer holding `fs:read` could read every file the user can.
 * Found by CodeGraph's own taint analysis run against this repository: it was the only sink
 * left reporting `tainted` after guard recognition, and reading the code confirmed it.
 *
 * **The model is capability, not allowlist.** A directory becomes readable because the user
 * picked it in the OS dialog - an explicit, revocable act of intent. Nothing else grants
 * access, so a compromised renderer inherits exactly the reach the user chose to give it and
 * cannot widen it by asking. This mirrors `@codegraph/fsx`, which the server side already uses.
 *
 * **Why the logic is restated rather than imported.** `@codegraph/fsx` ships raw TypeScript
 * (`exports: "./src/index.ts"`) and this process compiles with `module: CommonJS`,
 * `moduleResolution: "node"` - which ignores `exports` entirely. A live differential test
 * against `resolveSafe` was written and then removed: making `tsc` accept the import drags
 * fsx's whole source tree into this program and fails on `rootDir` and on fsx's own
 * `@codegraph/*` dependencies. Contorting an app's build to host one test is the wrong trade.
 *
 * That experiment did establish something worth keeping. **The two contracts genuinely differ
 * on absolute input.** `resolveSafe(root, relPath)` takes a workspace-RELATIVE path and strips
 * leading slashes, so `"/etc/passwd"` resolves to `<root>/etc/passwd` - inside, allowed, right
 * for its caller. `FsGrants` receives an already-absolute path off an IPC message, where
 * silently rewriting `/etc/passwd` to `<root>/etc/passwd` would answer a question the renderer
 * did not ask. It denies. Both are correct; do not "align" them.
 *
 * The escape classes are mirrored deliberately: lexical traversal, symlink-out-of-root, and
 * not-yet-existing targets. `fs-grants.test.ts` covers each, including the absolute-path case
 * that diverges.
 */
export class FsGrants {
  private readonly roots = new Set<string>();

  /** Record a directory the user explicitly selected. */
  grant(dir: string): void {
    this.roots.add(path.resolve(dir));
  }

  revoke(dir: string): void {
    this.roots.delete(path.resolve(dir));
  }

  list(): string[] {
    return [...this.roots];
  }

  /**
   * Resolve `candidate` and confirm it sits inside a granted root.
   *
   * Two checks, because either alone is bypassable. The lexical one stops `../../etc/passwd`.
   * The realpath one stops a symlink inside a granted directory pointing out of it - which the
   * lexical check happily accepts, since it never touches the filesystem. The probe walks up to
   * the nearest EXISTING ancestor: a write targets a file that does not exist yet, and
   * `realpathSync` on a missing path throws.
   */
  resolveWithinGrant(candidate: string): string | null {
    if (!candidate) return null;
    const full = path.resolve(candidate);
    for (const root of this.roots) {
      if (full !== root && !full.startsWith(root + path.sep)) continue;
      let rootReal: string;
      try {
        rootReal = realpathSync(root);
      } catch {
        // The granted directory has since disappeared; it grants nothing.
        continue;
      }
      let probe = full;
      for (;;) {
        try {
          const real = realpathSync(probe);
          if (real === rootReal || real.startsWith(rootReal + path.sep)) return full;
          break; // resolves outside the root - a symlink escape
        } catch {
          const parent = path.dirname(probe);
          if (parent === probe) break; // reached the filesystem root
          probe = parent;
        }
      }
    }
    return null;
  }
}
