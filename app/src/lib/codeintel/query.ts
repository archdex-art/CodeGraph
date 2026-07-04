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

    const strongconnect = (v: string) => {
      index.set(v, idx);
      low.set(v, idx);
      idx++;
      stack.push(v);
      onStack.add(v);
      for (const e of this.out.get(v) || []) {
        if (e.kind !== "calls") continue;
        const w = e.target;
        if (!index.has(w)) {
          strongconnect(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) sccs.push(comp);
      }
    };

    for (const s of this.graph.symbols) {
      if (!index.has(s.id)) strongconnect(s.id);
      if (sccs.length >= maxReport) break;
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
