import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface TimelineSnapshot {
  hash: string;
  timestamp: number; // Unix timestamp in seconds
  author: string;
  message: string;
  refs: string[]; // branches or tags pointing to this commit
}

export interface SelectionStrategy {
  (snapshots: TimelineSnapshot[]): TimelineSnapshot[];
}

export const Strategies = {
  everyCommit(): SelectionStrategy {
    return (snapshots) => snapshots;
  },
  
  everyNCommits(n: number): SelectionStrategy {
    return (snapshots) => snapshots.filter((_, i) => i % n === 0);
  },
  
  periodic(intervalSeconds: number): SelectionStrategy {
    return (snapshots) => {
      if (snapshots.length === 0) return [];
      const selected: TimelineSnapshot[] = [];
      let lastTime = 0;
      for (const s of snapshots) {
        if (s.timestamp - lastTime >= intervalSeconds) {
          selected.push(s);
          lastTime = s.timestamp;
        }
      }
      // Always include the very last commit if it's not already included
      const lastSnapshot = snapshots[snapshots.length - 1];
      if (selected[selected.length - 1]?.hash !== lastSnapshot.hash) {
        selected.push(lastSnapshot);
      }
      return selected;
    };
  },
  
  weekly(): SelectionStrategy {
    return Strategies.periodic(7 * 24 * 60 * 60);
  },
  
  monthly(): SelectionStrategy {
    return Strategies.periodic(30 * 24 * 60 * 60);
  },
  
  releaseTagsOnly(): SelectionStrategy {
    return (snapshots) => snapshots.filter(s => 
      s.refs.some(ref => ref.includes("tag: v") || ref.includes("tag: release"))
    );
  },
  
  adaptive(): SelectionStrategy {
    // For adaptive, we'd theoretically look at diff sizes, but based purely on
    // log metadata, we could sample merges or tagged commits, plus a monthly heartbeat.
    // For now, we combine monthly + tags.
    return (snapshots) => {
      const monthlyStr = Strategies.monthly();
      const tagsStr = Strategies.releaseTagsOnly();
      const s1 = monthlyStr(snapshots);
      const s2 = tagsStr(snapshots);
      const combined = new Map<string, TimelineSnapshot>();
      for (const s of [...s1, ...s2]) combined.set(s.hash, s);
      return Array.from(combined.values()).sort((a, b) => a.timestamp - b.timestamp);
    };
  }
};

const SEP = "\u0001";
/**
 * Parses Git history chronologically.
 */
export async function getTimeline(dir: string, strategy: SelectionStrategy = Strategies.everyCommit()): Promise<TimelineSnapshot[]> {
  try {
    // %H = hash, %ct = commit timestamp (unix), %an = author, %D = ref names, %s = subject
    const { stdout } = await exec(
      "git",
      ["log", "--reverse", `--pretty=format:%H${SEP}%ct${SEP}%an${SEP}%D${SEP}%s`],
      { cwd: dir, encoding: "utf8" }
    );
    
    if (!stdout.trim()) return [];
    
    const snapshots = stdout.split("\n").map(line => {
      const [hash, tsStr, author, refsStr, ...msgParts] = line.split(SEP);
      return {
        hash,
        timestamp: parseInt(tsStr, 10),
        author,
        refs: refsStr ? refsStr.split(",").map(r => r.trim()) : [],
        message: msgParts.join(SEP)
      };
    });
    
    return strategy(snapshots);
  } catch (err) {
    console.error("Failed to parse git timeline:", err);
    return [];
  }
}
