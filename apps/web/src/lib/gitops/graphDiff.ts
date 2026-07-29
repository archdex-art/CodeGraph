import type { VizGraph, GraphNode, GraphEdge, SymbolGraph, CodeSymbol, SymbolEdge } from "../types";
import type { ArchitectureSnapshot } from "./historicalAnalysis";

export interface NodeDiff<T> {
  added: T[];
  removed: T[];
  modified: Array<{ before: T; after: T }>;
}

export interface EdgeDiff<T> {
  added: T[];
  removed: T[];
}

export interface GraphDiff {
  files: NodeDiff<GraphNode>;
  fileEdges: EdgeDiff<GraphEdge>;
  symbols: NodeDiff<CodeSymbol>;
  symbolEdges: EdgeDiff<SymbolEdge>;
}

/**
 * Computes the structural difference between two historical architecture snapshots.
 */
export function diffSnapshots(
  older: ArchitectureSnapshot,
  newer: ArchitectureSnapshot
): GraphDiff {
  return {
    files: diffNodes(older.result.viz.nodes, newer.result.viz.nodes, n => n.id),
    fileEdges: diffEdges(older.result.viz.edges, newer.result.viz.edges, e => `${e.source}->${e.target}:${e.kind}`),
    symbols: diffNodes(older.result.symbolGraph.symbols, newer.result.symbolGraph.symbols, s => s.id),
    symbolEdges: diffEdges(older.result.symbolGraph.edges, newer.result.symbolGraph.edges, e => `${e.source}->${e.target}:${e.kind}`),
  };
}

function diffNodes<T>(
  older: T[],
  newer: T[],
  keyFn: (n: T) => string
): NodeDiff<T> {
  const oldMap = new Map<string, T>();
  for (const n of older) oldMap.set(keyFn(n), n);
  
  const newMap = new Map<string, T>();
  for (const n of newer) newMap.set(keyFn(n), n);
  
  const added: T[] = [];
  const removed: T[] = [];
  const modified: Array<{ before: T; after: T }> = [];
  
  for (const [key, newNode] of newMap.entries()) {
    const oldNode = oldMap.get(key);
    if (!oldNode) {
      added.push(newNode);
    } else {
      // In a real implementation, we would deeply compare properties here 
      // (e.g., LOC, complexity, fan-in) to detect 'modified' state.
      // For now, we assume identical IDs mean the identity is the same, 
      // and we just record the transition.
      modified.push({ before: oldNode, after: newNode });
    }
  }
  
  for (const [key, oldNode] of oldMap.entries()) {
    if (!newMap.has(key)) {
      removed.push(oldNode);
    }
  }
  
  return { added, removed, modified };
}

function diffEdges<T>(
  older: T[],
  newer: T[],
  keyFn: (e: T) => string
): EdgeDiff<T> {
  const oldSet = new Set<string>();
  for (const e of older) oldSet.add(keyFn(e));
  
  const newSet = new Set<string>();
  const added: T[] = [];
  
  for (const e of newer) {
    const key = keyFn(e);
    newSet.add(key);
    if (!oldSet.has(key)) {
      added.push(e);
    }
  }
  
  const removed: T[] = [];
  for (const e of older) {
    if (!newSet.has(keyFn(e))) {
      removed.push(e);
    }
  }
  
  return { added, removed };
}
