import * as fs from "fs/promises";
import * as path from "path";
import manifest from "./manifest.json";

/**
 * Paths, relative to a copied artifact's root, that must never enter the
 * Electron bundle.
 *
 * `apps/web/data/` is runtime state: `codegraph.sqlite` plus `data/workspaces/`,
 * which holds full git clones of every repository the operator has analysed.
 * Next's standalone writer copies that directory wholesale (see the NOTE in
 * `apps/web/next.config.ts` — `outputFileTracingExcludes` does not filter it,
 * because it is not reached via file tracing), so `.next/standalone` arrives
 * here already contaminated and this copy step is the last place to stop it.
 *
 * Reproduced before this guard existed: `build/standalone/apps/web/data` came
 * out at 16 MB containing the builder's own SQLite database and two cloned
 * repositories, all of which electron-builder would have packed into a
 * shippable .dmg. `.dockerignore` already enforces the same rule for the
 * container image; this is the Electron half.
 *
 * Matching is on path segments, so `data` cannot accidentally match
 * `metadata/` or a file named `data.js`.
 */
const EXCLUDED_PATHS: readonly string[][] = [
  ["apps", "web", "data"],
];

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split(path.sep).filter(Boolean);
  return EXCLUDED_PATHS.some((excluded) =>
    excluded.every((segment, i) => segments[i] === segment)
  );
}

/**
 * Recursive copy that skips EXCLUDED_PATHS.
 *
 * `fs.cp` has no filter that can express "skip this subtree", so the walk is
 * explicit. Symlinks are copied as links rather than followed, matching
 * `fs.cp`'s default and avoiding an unbounded walk through a cloned repo.
 */
async function copyFiltered(source: string, target: string, relative = ""): Promise<void> {
  if (relative && isExcluded(relative)) {
    console.log(`    · skipped (runtime state): ${relative}`);
    return;
  }

  const stats = await fs.lstat(source);

  if (stats.isSymbolicLink()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(await fs.readlink(source), target);
    return;
  }

  if (!stats.isDirectory()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return;
  }

  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source)) {
    await copyFiltered(
      path.join(source, entry),
      path.join(target, entry),
      relative ? path.join(relative, entry) : entry
    );
  }
}

/**
 * Executes the asset copy phase based strictly on the manifest.json
 */
export async function copyAssets(): Promise<void> {
  console.log("[Build] Starting Asset Collection Phase...");
  
  const sourceRoot = path.resolve(__dirname, manifest.sourceRoot);
  const targetRoot = path.resolve(__dirname, manifest.targetRoot);

  // Clean target directory
  try {
    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(targetRoot, { recursive: true });
  } catch (err) {
    console.error(`[Build] Failed to clean target directory: ${targetRoot}`);
    throw err;
  }

  for (const artifact of manifest.artifacts) {
    const sourcePath = path.join(sourceRoot, artifact.source);
    const targetPath = path.join(targetRoot, artifact.target);

    try {
      const stats = await fs.stat(sourcePath);
      
      if (artifact.type === "directory" && stats.isDirectory()) {
        await copyFiltered(sourcePath, targetPath);
        console.log(`  ✓ Copied directory: ${artifact.id}`);
      } else if (artifact.type === "file" && stats.isFile()) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
        console.log(`  ✓ Copied file: ${artifact.id}`);
      } else {
        throw new Error(`Type mismatch for ${artifact.id}: Expected ${artifact.type}`);
      }
    } catch (error) {
      if (artifact.required) {
        console.error(`[Build] FATAL: Required artifact missing or failed to copy: ${artifact.id}`);
        console.error(`          Source: ${sourcePath}`);
        throw error;
      } else {
        console.warn(`[Build] WARN: Optional artifact missing: ${artifact.id}`);
      }
    }
  }

  console.log("[Build] Asset Collection Complete.\n");
}
