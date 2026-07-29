import type { TimelineSnapshot } from "./timeline";
import { loadSnapshotCache } from "./timelineStore";
import type { ArchitectureSnapshot } from "./historicalAnalysis";
import { diffSnapshots, type GraphDiff } from "./graphDiff";
import { analyzeEvolution, type ArchitectureEvolution } from "./evolutionEngine";

export class TimelineController {
  private currentIndex: number = 0;
  private isPlaying: boolean = false;
  private playIntervalId?: NodeJS.Timeout;

  constructor(
    private repoId: string,
    private timeline: TimelineSnapshot[],
    private onSnapshotChange?: (snapshot: ArchitectureSnapshot | null) => void
  ) {}

  public get currentSnapshot(): TimelineSnapshot | undefined {
    return this.timeline[this.currentIndex];
  }
  
  public get timelineLength(): number {
    return this.timeline.length;
  }

  public async goto(indexOrHash: number | string): Promise<ArchitectureSnapshot | null> {
    if (typeof indexOrHash === "number") {
      if (indexOrHash >= 0 && indexOrHash < this.timeline.length) {
        this.currentIndex = indexOrHash;
      }
    } else {
      const idx = this.timeline.findIndex(s => s.hash === indexOrHash);
      if (idx !== -1) {
        this.currentIndex = idx;
      }
    }
    
    return this.emitCurrent();
  }

  public async next(): Promise<ArchitectureSnapshot | null> {
    if (this.currentIndex < this.timeline.length - 1) {
      this.currentIndex++;
      return this.emitCurrent();
    }
    this.pause();
    return null;
  }

  public async previous(): Promise<ArchitectureSnapshot | null> {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.emitCurrent();
    }
    return null;
  }

  public play(intervalMs: number = 1000): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    this.playIntervalId = setInterval(async () => {
      const hasNext = this.currentIndex < this.timeline.length - 1;
      if (!hasNext) {
        this.pause();
        return;
      }
      // Note: in a real environment, we'd wait for loading before advancing again
      // to avoid overlapping race conditions.
      await this.next();
    }, intervalMs);
  }

  public pause(): void {
    this.isPlaying = false;
    if (this.playIntervalId) {
      clearInterval(this.playIntervalId);
      this.playIntervalId = undefined;
    }
  }

  public async compare(hashA: string, hashB: string): Promise<ArchitectureEvolution | null> {
    const snapA = await loadSnapshotCache(this.repoId, hashA);
    const snapB = await loadSnapshotCache(this.repoId, hashB);
    
    if (!snapA || !snapB) return null;
    
    return analyzeEvolution(snapA, snapB);
  }

  private async emitCurrent(): Promise<ArchitectureSnapshot | null> {
    const snap = this.currentSnapshot;
    if (!snap) return null;
    
    const architecture = await loadSnapshotCache(this.repoId, snap.hash);
    
    if (this.onSnapshotChange) {
      this.onSnapshotChange(architecture);
    }
    
    return architecture;
  }
}
