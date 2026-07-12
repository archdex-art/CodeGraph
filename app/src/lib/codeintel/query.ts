import type { CodeSymbol, SymbolEdge, SymbolGraph } from "../types";

/**
 * QueryEngine: deterministic graph queries over the symbol graph.
 * Answers the "IDE-grade" questions the AI context engine and UI both rely on.
 */
export class QueryEngine {
  private byId = new Map<string, CodeSymbol>();
  private byName = new Map<string, CodeSymbol[]>();
  private out = new Map<string, SymbolEdge[]>(); // source -> edges
  private inc = new Map<string, SymbolEdge[]>(); // target -> edges

  constructor(private graph: SymbolGraph) {
    for (const s of graph.symbols) {
      this.byId.set(s.id, s);
      const l = this.byName.get(s.name) || [];
      l.push(s);
      this.byName.set(s.name, l);
    }
    for (const e of graph.edges) {
      (this.out.get(e.source) || this.out.set(e.source, []).get(e.source)!).push(e);
      (this.inc.get(e.target) || this.inc.set(e.target, []).get(e.target)!).push(e);
    }
  }

  get(id: string): CodeSymbol | undefined {
    return this.byId.get(id);
  }

  /** Fuzzy symbol search by name/signature/tag, ranked. */
  search(q: string, limit = 30): CodeSymbol[] {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const scored: Array<{ s: CodeSymbol; score: number }> = [];
    for (const s of this.graph.symbols) {
      const name = s.name.toLowerCase();
      let score = 0;
      if (name === query) score = 100;
      else if (name.startsWith(query)) score = 70;
      else if (name.includes(query)) score = 45;
      else if (s.tags.includes(query)) score = 35;
      else if (s.signature.toLowerCase().includes(query)) score = 20;
      else if (s.doc && s.doc.toLowerCase().includes(query)) score = 12;
      if (score > 0) {
        score += Math.min(15, s.fanIn) + (s.exported ? 5 : 0);
        scored.push({ s, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.s);
  }

  /** Callees: symbols this one calls. */
  callees(id: string): CodeSymbol[] {
    return (this.out.get(id) || [])
      .filter((e) => e.kind === "calls")
      .map((e) => this.byId.get(e.target))
      .filter((s): s is CodeSymbol => !!s);
  }

  /** Callers: symbols that call this one. */
  callers(id: string): CodeSymbol[] {
    return (this.inc.get(id) || [])
      .filter((e) => e.kind === "calls")
      .map((e) => this.byId.get(e.source))
      .filter((s): s is CodeSymbol => !!s);
  }

  /** Members of a container (class -> methods). */
  members(id: string): CodeSymbol[] {
    return (this.out.get(id) || [])
      .filter((e) => e.kind === "contains")
      .map((e) => this.byId.get(e.target))
      .filter((s): s is CodeSymbol => !!s);
  }

  /** Impact set: transitive callers up to depth (who breaks if this changes). */
  impact(id: string, depth = 3): CodeSymbol[] {
    const seen = new Set<string>([id]);
    let frontier = [id];
    const out: CodeSymbol[] = [];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const c of this.callers(cur)) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            out.push(c);
            next.push(c.id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Forward reachability: symbols reachable via outgoing calls within `depth`
   * hops, with the shortest hop-count each was first reached at. Used for
   * shallow taint-style analysis (does a "source" function's call chain reach
   * a "sink" function within N hops), the mirror direction of `impact()`. */
  reachableCallees(id: string, depth = 3): Array<{ symbol: CodeSymbol; hops: number }> {
    const seen = new Set<string>([id]);
    let frontier = [id];
    const out: Array<{ symbol: CodeSymbol; hops: number }> = [];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const c of this.callees(cur)) {
          if (!seen.has(c.id)) {
            seen.add(c.id);
            out.push({ symbol: c, hops: d });
            next.push(c.id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Smallest symbol (by line span) enclosing `line` in `file` — resolves an
   * (file, line) locus (e.g. an issue's location) to the function/method that
   * contains it, for graph-aware analyses like taint reachability. */
  symbolAt(file: string, line: number): CodeSymbol | undefined {
    let best: CodeSymbol | undefined;
    for (const s of this.graph.symbols) {
      if (s.file !== file) continue;
      if (line < s.line || line > s.endLine) continue;
      if (!best || s.endLine - s.line < best.endLine - best.line) best = s;
    }
    return best;
  }

  /** Dead code: exported-or-not symbols with zero resolved callers and not entrypoints. */
  deadCode(): CodeSymbol[] {
    return this.graph.symbols.filter(
      (s) =>
        (s.kind === "function" || s.kind === "method") &&
        s.fanIn === 0 &&
        !/^(main|default|handler|index|render|app|page|route|get|post|put|delete|constructor)$/i.test(s.name) &&
        !s.tags.includes("test")
    );
  }

  /** Detect call cycles (SCCs of size>1 or self-loops) via DFS. */
  cycles(maxReport = 20): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let idx = 0;
    const sccs: string[][] = [];

    // Iterative Tarjan's SCC
    // State: [nodeId, edgeIndex]
    for (const s of this.graph.symbols) {
      if (index.has(s.id)) continue;
      if (sccs.length >= maxReport) break;
      
      const callStack: [string, number][] = [[s.id, 0]];
      
      // "enter" logic for the root
      index.set(s.id, idx);
      low.set(s.id, idx);
      idx++;
      stack.push(s.id);
      onStack.add(s.id);

      while (callStack.length > 0) {
        const [v, i] = callStack[callStack.length - 1];
        const edges = this.out.get(v) || [];
        let advanced = false;

        for (let j = i; j < edges.length; j++) {
          const e = edges[j];
          if (e.kind !== "calls") continue;
          const w = e.target;

          if (!index.has(w)) {
            // Save current progress, we will resume after `w` is visited
            callStack[callStack.length - 1][1] = j + 1;
            
            // "enter" logic for w
            index.set(w, idx);
            low.set(w, idx);
            idx++;
            stack.push(w);
            onStack.add(w);
            
            callStack.push([w, 0]);
            advanced = true;
            break; // Dive into `w`
          } else if (onStack.has(w)) {
            low.set(v, Math.min(low.get(v)!, index.get(w)!));
          }
        }

        if (advanced) continue; // we pushed something to stack, let it run

        // We finished visiting all edges of `v`
        callStack.pop();
        
        // Update parent's low-link value
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1][0];
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }

        // Generate SCC if `v` is a root node
        if (low.get(v) === index.get(v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== v);
          
          if (comp.length > 1) {
            sccs.push(comp);
            if (sccs.length >= maxReport) break;
          }
        }
      }
    }

    return sccs.slice(0, maxReport).map((c) => c.map((id) => this.byId.get(id)?.name || id));
  }

  /** Hub symbols: highest connectivity (fanIn+fanOut). */
  hubs(limit = 15): CodeSymbol[] {
    return [...this.graph.symbols]
      .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut))
      .slice(0, limit);
  }

  outEdges(id: string): SymbolEdge[] {
    return this.out.get(id) || [];
  }
  incEdges(id: string): SymbolEdge[] {
    return this.inc.get(id) || [];
  }
}
