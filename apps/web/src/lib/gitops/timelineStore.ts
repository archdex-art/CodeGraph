import { mkdirSync, existsSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../db";
import type { ArchitectureSnapshot } from "./historicalAnalysis";

/**
 * Ensures the timeline directory for a repo exists.
 */
function getTimelineDir(repoId: string): string {
  const dir = path.join(dataDir(), "timeline", repoId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getSnapshotPath(repoId: string, hash: string): string {
  return path.join(getTimelineDir(repoId), `${hash}.json`);
}

/**
 * Saves a full architectural snapshot to disk cache.
 */
export async function saveSnapshot(repoId: string, snapshot: ArchitectureSnapshot): Promise<void> {
  const filePath = getSnapshotPath(repoId, snapshot.timeline.hash);
  await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
}

/**
 * Loads a cached architectural snapshot.
 */
export async function loadSnapshotCache(repoId: string, hash: string): Promise<ArchitectureSnapshot | null> {
  const filePath = getSnapshotPath(repoId, hash);
  if (!existsSync(filePath)) return null;
  
  try {
    const data = await readFile(filePath, "utf8");
    return JSON.parse(data) as ArchitectureSnapshot;
  } catch (err) {
    console.warn(`Failed to parse timeline snapshot ${hash} for repo ${repoId}`, err);
    return null;
  }
}

/**
 * Checks if a snapshot is already cached without loading it into memory.
 */
export function hasSnapshot(repoId: string, hash: string): boolean {
  return existsSync(getSnapshotPath(repoId, hash));
}

/**
 * Lists all cached snapshot hashes for a repo.
 */
export async function listSnapshots(repoId: string): Promise<string[]> {
  const dir = getTimelineDir(repoId);
  try {
    const files = await readdir(dir);
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
  } catch {
    return [];
  }
}
