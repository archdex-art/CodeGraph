import { getTimeline, Strategies, type TimelineSnapshot, type SelectionStrategy } from "./timeline";
import { loadSnapshot } from "./snapshotLoader";
import { analyzeSnapshot, type ArchitectureSnapshot, type SnapshotMetrics } from "./historicalAnalysis";
import type { ArchitectureEvolution } from "./evolutionEngine";
import { saveSnapshot, loadSnapshotCache, hasSnapshot, listSnapshots } from "./timelineStore";
import { TimelineController } from "./timelineController";
import type { GraphDiff } from "./graphDiff";

export { Strategies };
export type { TimelineSnapshot, ArchitectureSnapshot, SnapshotMetrics, GraphDiff, ArchitectureEvolution };

/**
 * High-level Analytics API for Timeline Engine (Phase 9 & 10)
 */
export class TimelineEngine {
  constructor(private repoId: string, private repoDir: string) {}

  /**
   * Initializes or retrieves the full timeline metadata using a specific strategy.
   */
  public async getTimeline(strategyName: keyof typeof Strategies = "everyCommit"): Promise<TimelineSnapshot[]> {
    const strategyFn = Strategies[strategyName] as () => SelectionStrategy;
    return getTimeline(this.repoDir, typeof strategyFn === "function" ? strategyFn() : Strategies.everyCommit());
  }

  /**
   * Generates and caches an architecture snapshot for a specific commit.
   * If already cached, returns immediately.
   */
  public async ensureSnapshot(hash: string): Promise<void> {
    if (hasSnapshot(this.repoId, hash)) {
      const existing = await loadSnapshotCache(this.repoId, hash);
      if (existing?.evolution && existing.evolution.metrics && existing.evolution.metrics.coupling <= 1.0) return; // Valid modern cache with v2 math, skip rebuild
    }

    const timeline = await this.getTimeline("everyCommit");
    const snapshotIndex = timeline.findIndex(t => t.hash === hash);
    
    if (snapshotIndex === -1) {
      throw new Error(`Commit ${hash} not found in timeline`);
    }
    const snapshotMeta = timeline[snapshotIndex];

    let previousSnapshot: ArchitectureSnapshot | null = null;
    if (snapshotIndex > 0) {
      const prevHash = timeline[snapshotIndex - 1].hash;
      previousSnapshot = await loadSnapshotCache(this.repoId, prevHash);
    }

    const loaded = await loadSnapshot(this.repoDir, hash);
    try {
      const architecture = await analyzeSnapshot(snapshotMeta, loaded, previousSnapshot);
      await saveSnapshot(this.repoId, architecture);
    } finally {
      await loaded.cleanup();
    }
  }

  /**
   * Gets a fully populated TimelineController ready for playback.
   */
  public async getController(
    strategy: keyof typeof Strategies = "monthly", 
    onSnapshotChange?: (snap: ArchitectureSnapshot | null) => void
  ): Promise<TimelineController> {
    const timeline = await this.getTimeline(strategy);
    return new TimelineController(this.repoId, timeline, onSnapshotChange);
  }

  /**
   * Pre-computes the entire timeline for a given strategy.
   */
  public async buildTimeline(strategy: keyof typeof Strategies = "monthly"): Promise<void> {
    const timeline = await this.getTimeline(strategy);
    for (const entry of timeline) {
      await this.ensureSnapshot(entry.hash);
    }
  }
  
  /**
   * Aggregates metrics across the cached timeline for trend charts.
   */
  public async getMetricTrends(): Promise<Array<{ hash: string, timestamp: number, metrics: SnapshotMetrics }>> {
    const hashes = await listSnapshots(this.repoId);
    const trends: Array<{ hash: string, timestamp: number, metrics: SnapshotMetrics }> = [];
    
    for (const hash of hashes) {
      const snap = await loadSnapshotCache(this.repoId, hash);
      if (snap) {
        trends.push({
          hash,
          timestamp: snap.timeline.timestamp,
          metrics: snap.metrics
        });
      }
    }
    
    return trends.sort((a, b) => a.timestamp - b.timestamp);
  }
}
