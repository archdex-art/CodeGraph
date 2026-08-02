import ts from "typescript";
import { describe, expect, it } from "vitest";
import { classifyTaint, type TaintQuery } from "../src/index";

/**
 * Intraprocedural taint (PLAN.md P5 item 2).
 *
 * Measured on this repository before it existed: `eslint-plugin-security` produced 170 sink
 * findings, all at the same confidence. Only **2** reach a sink from a user-controlled source;
 * 152 have no traceable source at all. Those 2 were a genuine unrestricted read/write over
 * Electron IPC (`apps/desktop/src/main/services/filesystem.ts`), fixed in the same commit.
 */
const Q: TaintQuery = {
  sourceRoots: new Set(["req", "request"]),
  sourceExpressions: [/^process\.argv\b/],
  sanitizers: new Set(["escapeHtml", "resolveSafe"]),
};

function verdict(src: string) {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  let arg: ts.Expression | null = null;
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "sink") {
      arg = n.arguments[0];
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (!arg) throw new Error("fixture has no sink() call");
  return classifyTaint(arg, Q);
}

describe("classifyTaint", () => {
  it("reports a source reaching a sink", () => {
    expect(verdict("function h(req: any) { const p = req.query.f; sink(p); }")).toBe("tainted");
  });

  it("reports an internal value as untraced, not tainted", () => {
    // 89% of real sink findings land here. They are downgraded, never deleted.
    expect(verdict("function h() { const p = cfg.dir; sink(p); }")).toBe("untraced");
  });

  it("does not treat a parameter as a source", () => {
    // Otherwise every function taking an argument lights up. Cross-function propagation is
    // P5 item 4, bounded to depth 3.
    expect(verdict("function h(p: string) { sink(p); }")).toBe("untraced");
  });

  it("recognises a transforming sanitizer", () => {
    expect(verdict("function h(req: any) { const p = escapeHtml(req.b); sink(p); }")).toBe("sanitized");
  });

  it("recognises an early-return guard, which no def-use walk can see", () => {
    // JS validates far more often than it transforms: check a predicate, bail, use the
    // ORIGINAL value. No assignment happens, so only control flow reveals it.
    const src = "function h(req: any) { const p = req.q; if (!ok(p)) return; sink(p); }";
    expect(verdict(src)).toBe("sanitized");
  });

  it("sees a guard inside a try block", () => {
    // Found by running this against the real fix: the guard sat in a `try`, the scan only
    // looked at statements directly in the function body, and the fixed code still read as
    // tainted. `try` wrapping is ubiquitous.
    const src = "function h(req: any) { try { const p = req.q; if (!ok(p)) return; sink(p); } catch (e) {} }";
    expect(verdict(src)).toBe("sanitized");
  });

  it("does NOT accept a guard nested in a conditional branch", () => {
    // It does not dominate the sink, so honouring it would suppress a real finding.
    const src = "function h(req: any) { const p = req.q; if (a) { if (!ok(p)) return; } sink(p); }";
    expect(verdict(src)).toBe("tainted");
  });

  it("reports tainted when only ONE branch is clean", () => {
    // The lattice join. Global "saw a source"/"saw a sanitizer" booleans call this sanitized -
    // a false negative, the direction that actually hurts.
    const src = "function h(req: any) { let p; if (a) { p = escapeHtml(req.x); } else { p = req.y; } sink(p); }";
    expect(verdict(src)).toBe("tainted");
  });

  it("terminates on a self-referential assignment", () => {
    // `x = f(x)` is ordinary in normalisation loops and would otherwise recurse forever.
    expect(verdict("function h() { let p = base; p = norm(p); sink(p); }")).toBe("untraced");
  });

  it("finds a source in a member expression, not just a bare identifier", () => {
    expect(verdict("function h() { sink(process.argv[2]); }")).toBe("tainted");
  });

  it("ignores a guard whose branch does not exit", () => {
    // `if (!ok(p)) { log(p); }` falls through and protects nothing. Honouring it would
    // suppress a real finding, which is the failure direction that matters.
    const src = "function h(req: any) { const p = req.q; if (!ok(p)) { log(p); } sink(p); }";
    expect(verdict(src)).toBe("tainted");
  });

  it("ignores a guard that appears AFTER the use", () => {
    // Position order stands in for dominance; a check below the sink dominates nothing.
    const src = "function h(req: any) { const p = req.q; sink(p); if (!ok(p)) return; }";
    expect(verdict(src)).toBe("tainted");
  });
});
