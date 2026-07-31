import ts from "typescript";

/**
 * Intraprocedural backward data flow: can this expression carry a value from a source?
 *
 * **Why this exists.** `eslint-plugin-security` flags any non-literal argument to a filesystem
 * call. On this repository that is 136 of 200 findings - 68% from one rule - and reading them
 * shows `mkdirSync(dir)` where `dir` came from config, `statSync(full)` inside a directory
 * walk, and temp paths in tests. None of it attacker-controlled. The rule cannot tell, because
 * it never asks where the value came from.
 *
 * **What this is not.** Flow-INsensitive and intraprocedural: it unions every assignment to a
 * name anywhere in the enclosing function, ignoring order and branches. That over-approximates
 * - it will call a value tainted when only one unreached branch taints it - which is the safe
 * direction for a security check. Cross-function propagation is out of scope by construction
 * (PLAN.md P5 item 4, bounded to depth 3); a parameter is NOT treated as a source here, or
 * every function taking an argument would light up.
 *
 * **Sanitizers cut the walk.** A value that passes through a sanitizing call is clean from
 * that point back, which is the single largest false-positive reducer once sources are known.
 */

export interface TaintQuery {
  /** Identifier names that introduce untrusted data, e.g. `req`, `request`. */
  sourceRoots: ReadonlySet<string>;
  /** Full member paths that introduce it, e.g. `process.argv`. Matched on text. */
  sourceExpressions: readonly RegExp[];
  /** Call names that neutralise a value: `escapeHtml`, `assertContained`. */
  sanitizers: ReadonlySet<string>;
}

export type TaintVerdict = "tainted" | "sanitized" | "untraced";

/** The nearest enclosing function-like node, or the source file for module scope. */
function enclosingBody(node: ts.Node): ts.Node {
  let n: ts.Node | undefined = node;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessor(n) ||
      ts.isSetAccessor(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return node.getSourceFile();
}

/**
 * Every expression assigned to `name` within `body`, from both `const x = ...` declarations and
 * plain `x = ...` assignments. Flow-insensitive on purpose - see the module comment.
 */
function assignmentsWithin(body: ts.Node, name: string): ts.Expression[] {
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      out.push(n.initializer);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      out.push(n.right);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return out;
}

/**
 * Does `expr` carry data from a source, and was it sanitized on the way?
 *
 * Walks backward through assignments within the enclosing function. `seen` bounds the walk, so
 * a self-referential assignment (`x = f(x)`, common in normalisation loops) terminates instead
 * of recursing forever - a real hazard, not a defensive flourish.
 */
/**
 * Names protected by a dominating early-return guard, e.g.
 *
 *     if (!withinConfiguredRoot(target)) return NextResponse.json(..., { status: 403 });
 *     readdirSync(target);            // <- safe, and flow-INsensitive analysis cannot see it
 *
 * **Why this is the CFG half of the work.** Sanitizers as *transforms* (`escapeHtml(x)`) are
 * easy: the value changes shape, so a backward walk meets them. JavaScript overwhelmingly
 * validates instead - check a predicate, bail out early, then use the ORIGINAL value. No
 * assignment happens, so a def-use walk sees nothing and reports a false positive. This was
 * found by running the analysis against this repository and reading the output:
 * `apps/web/src/app/api/browse/route.ts` was flagged four times and is guarded on the line
 * above each sink.
 *
 * A guard counts only if its `then` branch definitely leaves - `return` or `throw`. Anything
 * else falls through and protects nothing. Position order stands in for dominance, which is
 * exact for the early-return shape this targets and conservative elsewhere: a guard inside a
 * loop or a nested branch simply is not collected, so it under-claims rather than over-claims.
 */
function guardedNames(body: ts.Node, beforePos: number): Set<string> {
  const guarded = new Set<string>();
  const alwaysExits = (n: ts.Node): boolean => {
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) return true;
    if (ts.isBlock(n)) return n.statements.some(alwaysExits);
    return false;
  };
  /**
   * The statements that run unconditionally, in order, on the way to the use.
   *
   * Flattens `Block` and the try-block of a `TryStatement`, because both execute in sequence -
   * and `try { const safe = confine(x); if (safe === null) return; use(safe); }` is the shape
   * this whole function exists for. A first version looked only at statements directly in the
   * function body, so every guard inside a `try` was invisible; the fix for the vulnerability
   * this analysis found was still reported as tainted, which is how the gap surfaced.
   *
   * Deliberately does NOT descend into if-branches, loops, catch or finally. A guard in a
   * conditional branch does not dominate code after it, and claiming otherwise would suppress
   * real findings - the failure direction that matters here.
   */
  const linearStatements = (n: ts.Node): ts.Statement[] => {
    const src = ts.isBlock(n) || ts.isSourceFile(n)
      ? n.statements
      : (() => {
          const b = (n as ts.FunctionLikeDeclaration).body;
          return b && ts.isBlock(b) ? b.statements : ts.factory.createNodeArray<ts.Statement>([]);
        })();
    const out: ts.Statement[] = [];
    for (const st of src) {
      out.push(st);
      if (ts.isBlock(st)) out.push(...linearStatements(st));
      else if (ts.isTryStatement(st)) out.push(...linearStatements(st.tryBlock));
    }
    return out;
  };
  for (const st of linearStatements(body)) {
    if (st.getStart() >= beforePos) break; // only guards that precede the use
    if (!ts.isIfStatement(st) || !alwaysExits(st.thenStatement)) continue;
    const collect = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) guarded.add(n.text);
      ts.forEachChild(n, collect);
    };
    collect(st.expression);
  }
  return guarded;
}

export function classifyTaint(expr: ts.Expression, q: TaintQuery): TaintVerdict {
  const body = enclosingBody(expr);
  const guarded = guardedNames(body, expr.getStart());

  /**
   * Verdicts form a lattice ordered `tainted > sanitized > untraced`, and a node's verdict is
   * the JOIN over its paths.
   *
   * Per-path, not global flags. With one boolean each for "saw a source" and "saw a
   * sanitizer", `if (a) p = clean(req.x); else p = req.y` sets both and reports *sanitized* -
   * while the `else` branch is genuinely tainted. That is a false negative in a security
   * check, which is the direction that actually hurts. Joining per path reports *tainted*,
   * because one dirty path is enough.
   */
  const join = (a: TaintVerdict, b: TaintVerdict): TaintVerdict =>
    a === "tainted" || b === "tainted" ? "tainted"
      : a === "sanitized" || b === "sanitized" ? "sanitized"
        : "untraced";

  /**
   * `depth` is the single termination bound, and it is load-bearing: `x = f(x)` is ordinary in
   * normalisation code and would otherwise recurse forever.
   *
   * A per-path visited set was written here and REMOVED after measuring it: 30ms vs 29ms on a
   * depth-12, 4-way-branching fixture. It prunes only within one path, never across branches,
   * so the depth cap was already doing all the work. Two termination mechanisms where one is
   * inert is one too many.
   */
  const inspect = (node: ts.Node, depth: number): TaintVerdict => {
    if (depth > 12) return "untraced";

    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      // A sanitizing call cleans this path whatever fed it. Descending past it would only
      // rediscover the source it was placed there to neutralise.
      if (q.sanitizers.has(callee)) return "sanitized";
    }

    for (const re of q.sourceExpressions) {
      if (re.test(node.getText())) return "tainted";
    }

    if (ts.isIdentifier(node)) {
      // A dominating early-return guard cleans the name for every later use.
      if (guarded.has(node.text)) return "sanitized";
      if (q.sourceRoots.has(node.text)) return "tainted";
      let v: TaintVerdict = "untraced";
      for (const def of assignmentsWithin(body, node.text)) v = join(v, inspect(def, depth + 1));
      return v;
    }

    let v: TaintVerdict = "untraced";
    ts.forEachChild(node, (c) => {
      v = join(v, inspect(c, depth + 1));
    });
    return v;
  };

  return inspect(expr, 0);
}

/**
 * Locate the call expression that starts at a 1-indexed `line`/`column`, so a finding reported
 * by a line-based linter can be re-examined structurally.
 */
export function callAt(sf: ts.SourceFile, line: number, column: number): ts.CallExpression | null {
  let best: ts.CallExpression | null = null;
  const target = ts.getPositionOfLineAndCharacter(sf, Math.max(0, line - 1), Math.max(0, column - 1));
  const walk = (n: ts.Node): void => {
    if (n.getStart(sf) <= target && target < n.getEnd()) {
      if (ts.isCallExpression(n)) best = n;
      ts.forEachChild(n, walk);
    }
  };
  ts.forEachChild(sf, walk);
  return best;
}
