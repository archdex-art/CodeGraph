import ts from "typescript";
import { classifyTaint, type TaintQuery, type TaintVerdict } from "./dataflow";
import { QueryEngine } from "./query";
import type { SymbolGraph } from "./symbol";

/**
 * Inter-procedural taint: does an attacker-controlled VALUE reach a dangerous call?
 *
 * **What this replaces, and why.** The shipped approximation found sources with
 * `/\(\s*(?:req|request)\b/i`, took sinks from lines a linter had already flagged, and then
 * asked the call graph whether the sink function was reachable within three hops. Reachability
 * is not data flow. `handler(req)` calling `log()` calling `exec(CONFIG.cmd)` is reachable and
 * carries nothing; `f(safe, tainted)` whose sink consumes `safe` is reachable and carries
 * nothing. Both were reported. The fix that makes this data flow is ARGUMENT-TO-PARAMETER
 * INDEX MAPPING: a value passed as argument N taints parameter N of the callee and only
 * parameter N, and the walk continues from that name inside the callee's body.
 *
 * Intra-procedural reasoning is delegated wholesale to `classifyTaint` in `dataflow.ts` -
 * including its early-return guard handling, which is the part no def-use walk can see. This
 * module supplies the frames: which names start tainted in which function, and how taint
 * crosses a call boundary in both directions (arguments in, return values out).
 *
 * **What this cannot see.** Named plainly, because a security result that hides its blind
 * spots is worse than no result:
 *   - *Aliasing.* `const alias = obj; alias.x = tainted; use(obj.x)` is invisible. Taint is
 *     tracked per NAME, not per storage location.
 *   - *Collections.* Pushing a tainted value into an array or a map and reading it back
 *     elsewhere loses the taint. There is no field- or element-sensitivity.
 *   - *Dynamic dispatch.* `handlers[key](tainted)` and calls through a parameter resolve to
 *     nothing, so the walk stops. An interface method with several implementations resolves to
 *     at most one of them (the lexicographically first), not to all.
 *   - *Unresolved cross-module calls.* If `buildSymbolGraph` produced no `calls` edge and no
 *     unique name match, the callee is not analysed. Such a call is a hole, not a clean path -
 *     nothing is reported for it either way.
 *   - *Destructured parameters.* `function f({ id })` has no name at index 0 to taint, so the
 *     walk stops there rather than guessing which binding received the value.
 *   - *Order.* `classifyTaint` is flow-INsensitive within a function (see its header), so a
 *     value tainted only on an unreachable branch is still reported. Over-approximating is the
 *     safe direction for a security check; it is not a claim of precision.
 *
 * Every one of those is a MISSED path, not a fabricated one, except the flow-insensitivity
 * noted last. Nothing here invents a source, a sink, or a hop it did not read from the AST.
 */

export interface TaintPath {
  readonly id: string;
  readonly source: { symbolId: string; file: string; line: number; evidence: string; kind: string };
  readonly sink: { symbolId: string; file: string; line: number; evidence: string; rule: string };
  readonly hops: ReadonlyArray<{ symbolId: string; name: string; file: string; line: number }>;
  readonly sanitized: boolean;
  /** Derived from chain length, how each call edge was resolved, and parameter certainty. */
  readonly confidence: number;
}

export interface TaintReport {
  readonly paths: readonly TaintPath[];
  /** True when a cap below stopped the walk. A `false` here is the only honest "we finished". */
  readonly truncated: boolean;
  /** Function-like symbols this analysis could locate in both the AST and the symbol graph. */
  readonly analysedSymbols: number;
}

/**
 * Bounds. Input is an attacker-authored repository, so every dimension that a hostile file
 * could grow is capped, and hitting any cap sets `truncated` rather than silently answering.
 */
/** Call hops past the source function. 4 covers route -> service -> repo -> driver. */
const MAX_CALL_DEPTH = 4;
/** Reported paths. Past this the report is a wall of text nobody reads anyway. */
const MAX_PATHS = 200;
/** Total frames analysed across the whole run - the guard against fan-out, not depth. */
const MAX_FRAMES = 2000;
/** Arguments inspected per call site; a 500-argument call is not a real call. */
const MAX_ARGS = 12;
/** Re-scans of one frame after a return value taints a local. 3 is a fixpoint in practice. */
const MAX_ROUNDS = 3;
/** AST nodes visited per frame - the per-function work cap for one huge generated function. */
const MAX_NODES_PER_FRAME = 20000;
/** Distinct sources seeded per function, so one file cannot fan out unboundedly. */
const MAX_SOURCES_PER_FUNCTION = 8;
/** Files larger than this are minified or generated; parsing them is not worth the time. */
const MAX_FILE_BYTES = 512 * 1024;
/** Evidence strings are for a human reading a report, not for reconstructing the program. */
const MAX_EVIDENCE = 160;

/** One source file as `buildSymbolGraph` receives it — the same shape, so callers pass both. */
export interface AnalysedFile {
  rel: string;
  ext: string;
  text: string;
  language: string;
}

const PARSEABLE_EXTS = new Map<string, true>(Object.entries({
  ".ts": true, ".tsx": true, ".mts": true, ".cts": true,
  ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
}));

/** Parameter types that make their parameter a request object regardless of its name. */
const REQUEST_TYPES = new Map<string, true>(Object.entries({
  Request: true, NextRequest: true, NextApiRequest: true, IncomingMessage: true,
  FastifyRequest: true,
}));

/** Parameter names that are conventionally the inbound request. */
const REQUEST_NAMES = new Map<string, true>(Object.entries({ req: true, request: true }));

/**
 * Source expressions, matched against the exact text of a property access or call node. Each
 * match becomes its own frame so that the reported source is the expression actually read,
 * not a category label.
 */
const SOURCE_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly re: RegExp }> = [
  { kind: "request-property", re: /^(?:req|request)\s*\.\s*(?:body|query|params|headers|cookies)\b/ },
  { kind: "request-json", re: /^(?:req|request)\s*\.\s*json\s*\(\s*\)$/ },
  { kind: "search-params", re: /^[\w$.]*searchParams\s*\.\s*get\s*\(/ },
  { kind: "process-argv", re: /^process\s*\.\s*argv\b/ },
  { kind: "process-env", re: /^process\s*\.\s*env\b/ },
];

type SinkSpec = { readonly rule: string; readonly args: readonly number[] };

/**
 * Sinks by callee name, with the argument positions that are actually dangerous. The positions
 * matter as much as the names: `db.query(sql, params)` is a sink at index 0 and a
 * parameterised query at index 1, and flagging index 1 is exactly the false positive that
 * makes people stop reading the tool's output.
 */
const CALL_SINKS = new Map<string, SinkSpec>(Object.entries({
  eval: { rule: "code-eval", args: [0] },
  exec: { rule: "command-exec", args: [0] },
  execSync: { rule: "command-exec", args: [0] },
  execFile: { rule: "command-exec", args: [0, 1] },
  execFileSync: { rule: "command-exec", args: [0, 1] },
  spawn: { rule: "command-exec", args: [0, 1] },
  spawnSync: { rule: "command-exec", args: [0, 1] },
  query: { rule: "sql-string-build", args: [0] },
  execute: { rule: "sql-string-build", args: [0] },
  raw: { rule: "sql-string-build", args: [0] },
  unsafe: { rule: "sql-string-build", args: [0] },
  queryRaw: { rule: "sql-string-build", args: [0] },
  executeRaw: { rule: "sql-string-build", args: [0] },
  readFile: { rule: "fs-path", args: [0] },
  readFileSync: { rule: "fs-path", args: [0] },
  writeFile: { rule: "fs-path", args: [0] },
  writeFileSync: { rule: "fs-path", args: [0] },
  appendFile: { rule: "fs-path", args: [0] },
  appendFileSync: { rule: "fs-path", args: [0] },
  readdir: { rule: "fs-path", args: [0] },
  readdirSync: { rule: "fs-path", args: [0] },
  unlink: { rule: "fs-path", args: [0] },
  unlinkSync: { rule: "fs-path", args: [0] },
  rm: { rule: "fs-path", args: [0] },
  rmSync: { rule: "fs-path", args: [0] },
  createReadStream: { rule: "fs-path", args: [0] },
  createWriteStream: { rule: "fs-path", args: [0] },
  redirect: { rule: "open-redirect", args: [0] },
  fetch: { rule: "ssrf-fetch", args: [0] },
}));

/** Assignment targets that write markup straight into the DOM. */
const DOM_SINK_PROPS = new Map<string, true>(Object.entries({ innerHTML: true, outerHTML: true }));

/**
 * Tag names of parameterised-query template builders. A tainted interpolation inside
 * ``sql`...${x}...` `` is bound, not concatenated, so the path is real but defended.
 */
const PARAM_QUERY_TAGS: Record<string, true> = { sql: true, sqlFragment: true };

/** Sanitizer names that need no corpus evidence: they are neutralising by definition. */
const FIXED_SANITIZERS: readonly string[] = [
  "encodeURIComponent", "encodeURI", "escape", "Number", "parseInt", "parseFloat",
  "escapeIdentifier", "escapeLiteral", "parameterize", "parameterise",
];

/** Receivers whose `.parse()` is schema validation rather than `JSON.parse`. */
const SCHEMA_RECEIVER = /(?:schema|validator|zod)$|^z$/i;

interface FnInfo {
  readonly symbolId: string;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly node: ts.FunctionLikeDeclaration;
  readonly sf: ts.SourceFile;
}

/** How a call site was matched to a callee. Each costs the path a different amount. */
type Resolution = "edge" | "edge-ambiguous" | "name" | "name-ambiguous";

const RESOLUTION_COST: Record<Resolution, number> = {
  edge: 0.02,
  "edge-ambiguous": 0.2,
  name: 0.12,
  "name-ambiguous": 0.25,
};

interface Frame {
  readonly fn: FnInfo;
  /** Names that hold attacker data on entry to this frame. Grows as returns taint locals. */
  readonly tainted: Set<string>;
  readonly expressions: readonly RegExp[];
  readonly sanitized: boolean;
  readonly chain: readonly FnInfo[];
  readonly depth: number;
  readonly cost: number;
  readonly unresolvedParam: boolean;
  readonly source: TaintPath["source"];
}

interface Ctx {
  readonly fnById: Map<string, FnInfo>;
  readonly fnByName: Map<string, FnInfo[]>;
  readonly edgeTargets: Map<string, string[]>;
  readonly sanitizers: ReadonlySet<string>;
  readonly paths: Map<string, TaintPath>;
  readonly visiting: Set<string>;
  frames: number;
  truncated: boolean;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Evidence is a single bounded line: reports are read in a terminal, not in an editor. */
function evidenceOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf).replace(/\s+/g, " ").trim();
  return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text;
}

/** Non-cryptographic djb2 - path ids only need to be stable and collision-unlikely. */
function pathId(parts: readonly string[]): string {
  let h = 5381;
  const joined = parts.join("|");
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  return `tp_${(h >>> 0).toString(36)}`;
}

/** Descend the whole subtree, honouring the per-frame work cap. Returns false when capped. */
function walkBounded(root: ts.Node, budget: { left: number }, visit: (n: ts.Node) => void): boolean {
  let ok = true;
  const step = (n: ts.Node): void => {
    if (budget.left <= 0) {
      ok = false;
      return;
    }
    budget.left--;
    visit(n);
    ts.forEachChild(n, step);
  };
  ts.forEachChild(root, step);
  return ok;
}

/** The callee name of a call: `helper(x)` -> `helper`, `db.query(x)` -> `query`. */
function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const target = call.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return "";
}

/**
 * Sanitizer names present in THIS corpus, so the set reflects code that exists rather than a
 * wish list. Prefix families (`escapeHtml`, `sanitizeInput`) are collected by scanning call
 * sites; `.parse()` is collected only when some receiver looks like a schema, because adding
 * `parse` unconditionally would make `JSON.parse(req.body)` read as sanitized - a false
 * NEGATIVE, the direction that actually hurts in a security check.
 */
function collectSanitizers(sources: readonly ts.SourceFile[]): ReadonlySet<string> {
  const names = new Set<string>(FIXED_SANITIZERS);
  for (const sf of sources) {
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (/^(?:escape|sanitize|sanitise|scrub)/i.test(name)) names.add(name);
        if (
          (name === "parse" || name === "safeParse") &&
          ts.isPropertyAccessExpression(n.expression) &&
          SCHEMA_RECEIVER.test(n.expression.expression.getText(sf))
        ) {
          names.add(name);
        }
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
  }
  return names;
}

/**
 * Function-like declarations that also exist as graph symbols. A function the graph does not
 * know about is skipped rather than given a made-up id: a report referring to a symbol nobody
 * can open is worse than one path fewer.
 */
function indexFunctions(sources: readonly ts.SourceFile[], qe: QueryEngine): Map<string, FnInfo> {
  const out = new Map<string, FnInfo>();
  for (const sf of sources) {
    const add = (name: string, node: ts.FunctionLikeDeclaration): void => {
      const line = lineOf(sf, node);
      const sym = qe.symbolAt(sf.fileName, line);
      if (!sym || out.has(sym.id)) return;
      out.set(sym.id, { symbolId: sym.id, name, file: sf.fileName, line, node, sf });
    };
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n);
      else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) add(n.name.text, n);
      else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        add(n.name.text, n.initializer);
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
  }
  return out;
}

/** The name bound at argument index `index`, and whether that binding is approximate. */
function parameterAt(fn: FnInfo, index: number): { name: string; approximate: boolean } | null {
  const params = fn.node.parameters;
  const direct = index < params.length ? params[index] : undefined;
  if (direct) {
    if (!ts.isIdentifier(direct.name)) return null; // destructured: no single name to taint
    // A rest parameter receives the value inside an array, so tracking it by name over-
    // approximates - the whole array is treated as tainted. Flagged so confidence drops.
    return { name: direct.name.text, approximate: direct.dotDotDotToken !== undefined };
  }
  const last = params.length > 0 ? params[params.length - 1] : undefined;
  if (last && last.dotDotDotToken && ts.isIdentifier(last.name)) {
    return { name: last.name.text, approximate: true };
  }
  return null; // more arguments than the callee declares: nothing receives this value
}

/** The local name a call's result is bound to, seeing through `await`. */
function assignedName(call: ts.Node): string | null {
  let node: ts.Node = call;
  if (node.parent && ts.isAwaitExpression(node.parent)) node = node.parent;
  const parent: ts.Node | undefined = node.parent;
  if (!parent) return null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === node) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left) &&
    parent.right === node
  ) {
    return parent.left.text;
  }
  return null;
}

interface SinkHit {
  readonly rule: string;
  readonly node: ts.Node;
  readonly args: readonly ts.Expression[];
}

function sinkAt(node: ts.Node): SinkHit | null {
  if (ts.isCallExpression(node)) {
    const spec = CALL_SINKS.get(calleeName(node));
    if (!spec) return null;
    const args: ts.Expression[] = [];
    for (const i of spec.args) {
      const a = i < Math.min(node.arguments.length, MAX_ARGS) ? node.arguments[i] : undefined;
      if (a) args.push(a);
    }
    return args.length > 0 ? { rule: spec.rule, node, args } : null;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
    const args = node.arguments ? node.arguments.slice(0, MAX_ARGS) : [];
    return args.length > 0 ? { rule: "code-eval", node, args } : null;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    DOM_SINK_PROPS.get(node.left.name.text)
  ) {
    return { rule: "dom-xss", node, args: [node.right] };
  }
  if (
    ts.isJsxAttribute(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "dangerouslySetInnerHTML" &&
    node.initializer &&
    ts.isJsxExpression(node.initializer) &&
    node.initializer.expression
  ) {
    return { rule: "dom-xss", node, args: [node.initializer.expression] };
  }
  return null;
}

/** Confidence falls with chain length, weak call resolution, and approximate parameters. */
function confidenceOf(chainLength: number, cost: number, unresolvedParam: boolean): number {
  const raw = 0.9 - 0.05 * (chainLength - 1) - cost - (unresolvedParam ? 0.15 : 0);
  return Math.round(Math.min(0.95, Math.max(0.05, raw)) * 100) / 100;
}

/** Where does the tainted value in a source live, and what should the report call it? */
interface SourceSeed {
  readonly roots: readonly string[];
  readonly expressions: readonly RegExp[];
  readonly kind: string;
  readonly line: number;
  readonly evidence: string;
}

function seedsFor(fn: FnInfo): SourceSeed[] {
  const seeds: SourceSeed[] = [];
  const rootNames = new Set<string>();

  for (const p of fn.node.parameters) {
    if (!ts.isIdentifier(p.name)) continue;
    const typeName =
      p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName)
        ? p.type.typeName.text
        : "";
    if (!REQUEST_NAMES.get(p.name.text) && !REQUEST_TYPES.get(typeName)) continue;
    rootNames.add(p.name.text);
    seeds.push({
      roots: [p.name.text],
      expressions: [],
      kind: "handler-parameter",
      line: lineOf(fn.sf, p),
      evidence: evidenceOf(p, fn.sf),
    });
  }

  const body = fn.node.body;
  if (!body) return seeds;
  const seen = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (seeds.length >= MAX_SOURCES_PER_FUNCTION) return;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) {
      const text = n.getText(fn.sf).replace(/\s+/g, " ").trim();
      if (text.length <= MAX_EVIDENCE && !seen.has(text)) {
        for (const p of SOURCE_PATTERNS) {
          if (!p.re.test(text)) continue;
          // A `req.body` inside a handler that already declares `req` is the SAME source. The
          // parameter seed covers it, and seeding both would report one flow twice.
          const root = text.split(/[.[(]/)[0]?.trim() ?? "";
          if (rootNames.has(root)) break;
          seen.add(text);
          seeds.push({
            roots: [],
            expressions: [new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)],
            kind: p.kind,
            line: lineOf(fn.sf, n),
            evidence: text,
          });
          break;
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return seeds;
}

/** Resolve a call to a callee we can walk into, preferring graph edges over bare name match. */
function resolveCallee(
  ctx: Ctx,
  callerId: string,
  name: string,
): { fn: FnInfo; resolution: Resolution } | null {
  if (name === "") return null;
  const viaEdge: FnInfo[] = [];
  for (const targetId of ctx.edgeTargets.get(callerId) ?? []) {
    const fn = ctx.fnById.get(targetId);
    if (fn && fn.name === name) viaEdge.push(fn);
  }
  if (viaEdge.length > 0) {
    viaEdge.sort((a, b) => (a.symbolId < b.symbolId ? -1 : 1));
    const first = viaEdge[0] as FnInfo;
    return { fn: first, resolution: viaEdge.length === 1 ? "edge" : "edge-ambiguous" };
  }
  const byName = ctx.fnByName.get(name);
  if (!byName || byName.length === 0) return null;
  const first = byName[0] as FnInfo;
  return { fn: first, resolution: byName.length === 1 ? "name" : "name-ambiguous" };
}

/**
 * Analyse one frame: report sinks reached by this frame's tainted names, descend into calls
 * with index mapping, and answer whether this function RETURNS a tainted value.
 */
function analyseFrame(ctx: Ctx, frame: Frame): { tainted: boolean; sanitized: boolean } {
  const key = `${frame.fn.symbolId}|${[...frame.tainted].sort().join(",")}|${frame.sanitized}`;
  // Recursion through a cycle re-enters with the same facts and would never terminate. The
  // second entry contributes nothing new, so cutting it loses no path.
  if (ctx.visiting.has(key)) return { tainted: false, sanitized: false };
  ctx.visiting.add(key);
  ctx.frames++;
  if (ctx.frames > MAX_FRAMES) {
    ctx.truncated = true;
    ctx.visiting.delete(key);
    return { tainted: false, sanitized: false };
  }

  const body = frame.fn.node.body;
  const result = { tainted: false, sanitized: false };
  if (!body) {
    ctx.visiting.delete(key);
    return result;
  }

  const q: TaintQuery = {
    sourceRoots: frame.tainted,
    sourceExpressions: frame.expressions,
    sanitizers: ctx.sanitizers,
  };
  const budget = { left: MAX_NODES_PER_FRAME };
  // Recursion into a callee is expensive; the verdict that triggered it is what makes it
  // distinct, so a re-scan after a return taints a local need not repeat identical work.
  const calleeCache = new Map<string, { tainted: boolean; sanitized: boolean }>();

  const hops = frame.chain.map((f) => ({ symbolId: f.symbolId, name: f.name, file: f.file, line: f.line }));

  const report = (hit: SinkHit, arg: ts.Expression, verdict: TaintVerdict): void => {
    if (ctx.paths.size >= MAX_PATHS) {
      ctx.truncated = true;
      return;
    }
    const parameterised =
      ts.isTaggedTemplateExpression(arg) &&
      ts.isIdentifier(arg.tag) &&
      PARAM_QUERY_TAGS[arg.tag.text] === true;
    const line = lineOf(frame.fn.sf, hit.node);
    const id = pathId([
      frame.source.symbolId,
      String(frame.source.line),
      frame.source.kind,
      ...frame.chain.map((f) => f.symbolId),
      frame.fn.file,
      String(line),
      hit.rule,
    ]);
    if (ctx.paths.has(id)) return;
    ctx.paths.set(id, {
      id,
      source: frame.source,
      sink: {
        symbolId: frame.fn.symbolId,
        file: frame.fn.file,
        line,
        evidence: evidenceOf(hit.node, frame.fn.sf),
        rule: hit.rule,
      },
      hops,
      sanitized: frame.sanitized || parameterised || verdict === "sanitized",
      confidence: confidenceOf(frame.chain.length, frame.cost, frame.unresolvedParam),
    });
  };

  /** One pass over the body. Returns the locals newly tainted by a callee's return value. */
  const scan = (): string[] => {
    const grown: string[] = [];
    const complete = walkBounded(body, budget, (n) => {
      const hit = sinkAt(n);
      if (hit) {
        for (const arg of hit.args) {
          const verdict = classifyTaint(arg, q);
          if (verdict !== "untraced") report(hit, arg, verdict);
        }
      }

      if (!ts.isCallExpression(n)) return;
      const name = calleeName(n);
      // A sanitizing call consumes the value; there is nothing tainted to hand onward.
      if (ctx.sanitizers.has(name)) return;
      const argCount = Math.min(n.arguments.length, MAX_ARGS);
      let returnsTainted = false;
      let returnsSanitized = false;

      for (let i = 0; i < argCount; i++) {
        const arg = n.arguments[i] as ts.Expression;
        const verdict = classifyTaint(arg, q);
        if (verdict === "untraced") continue;

        const resolved = resolveCallee(ctx, frame.fn.symbolId, name);
        if (!resolved) continue; // unresolved callee: a hole, reported as nothing
        if (frame.depth + 1 > MAX_CALL_DEPTH) {
          ctx.truncated = true;
          continue;
        }
        // THE index mapping. Argument i binds parameter i, and only parameter i becomes
        // tainted inside the callee. Dropping this is what turned the previous analysis into
        // plain reachability.
        const param = parameterAt(resolved.fn, i);
        if (!param) continue;

        const cacheKey = `${n.getStart(frame.fn.sf)}:${i}:${verdict}`;
        const cached = calleeCache.get(cacheKey);
        const ret =
          cached ??
          analyseFrame(ctx, {
            fn: resolved.fn,
            tainted: new Set([param.name]),
            expressions: [],
            sanitized: frame.sanitized || verdict === "sanitized",
            chain: [...frame.chain, resolved.fn],
            depth: frame.depth + 1,
            cost: frame.cost + RESOLUTION_COST[resolved.resolution],
            unresolvedParam: frame.unresolvedParam || param.approximate,
            source: frame.source,
          });
        if (!cached) calleeCache.set(cacheKey, ret);
        if (ret.tainted) returnsTainted = true;
        if (ret.sanitized || verdict === "sanitized") returnsSanitized = true;
      }

      if (!returnsTainted) return;
      const bound = assignedName(n);
      if (bound && !frame.tainted.has(bound)) {
        frame.tainted.add(bound);
        grown.push(bound);
      }
      if (returnsSanitized) result.sanitized = true;
    });
    if (!complete) ctx.truncated = true;
    return grown;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const grown = scan();
    if (grown.length === 0) break;
    if (round === MAX_ROUNDS - 1) ctx.truncated = true;
  }

  // Does this function hand the taint back out? Nested functions are skipped: their returns
  // belong to the closure, not to this call.
  const returnWalk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const verdict = classifyTaint(n.expression, q);
      if (verdict === "tainted") result.tainted = true;
      else if (verdict === "sanitized") {
        result.tainted = true;
        result.sanitized = true;
      }
    }
    ts.forEachChild(n, returnWalk);
  };
  if (ts.isBlock(body)) ts.forEachChild(body, returnWalk);
  else {
    const verdict = classifyTaint(body, q); // concise arrow body: the body IS the return
    if (verdict !== "untraced") {
      result.tainted = true;
      if (verdict === "sanitized") result.sanitized = true;
    }
  }

  ctx.visiting.delete(key);
  return result;
}

export function analyseTaint(files: ReadonlyArray<AnalysedFile>, graph: SymbolGraph): TaintReport {
  const ordered = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const sources: ts.SourceFile[] = [];
  let truncated = false;
  for (const file of ordered) {
    if (!PARSEABLE_EXTS.get(file.ext)) continue;
    if (file.text.length > MAX_FILE_BYTES) {
      truncated = true; // a skipped file is unanalysed, not clean
      continue;
    }
    const kind = file.ext.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sources.push(ts.createSourceFile(file.rel, file.text, ts.ScriptTarget.Latest, true, kind));
  }

  const qe = new QueryEngine(graph);
  const fnById = indexFunctions(sources, qe);
  const fnByName = new Map<string, FnInfo[]>();
  for (const fn of [...fnById.values()].sort((a, b) => (a.symbolId < b.symbolId ? -1 : 1))) {
    const bucket = fnByName.get(fn.name);
    if (bucket) bucket.push(fn);
    else fnByName.set(fn.name, [fn]);
  }
  const edgeTargets = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "calls") continue;
    const bucket = edgeTargets.get(edge.source);
    if (bucket) bucket.push(edge.target);
    else edgeTargets.set(edge.source, [edge.target]);
  }

  const ctx: Ctx = {
    fnById,
    fnByName,
    edgeTargets,
    sanitizers: collectSanitizers(sources),
    paths: new Map<string, TaintPath>(),
    visiting: new Set<string>(),
    frames: 0,
    truncated,
  };

  for (const fn of [...fnById.values()].sort((a, b) => (a.symbolId < b.symbolId ? -1 : 1))) {
    for (const seed of seedsFor(fn)) {
      analyseFrame(ctx, {
        fn,
        tainted: new Set(seed.roots),
        expressions: seed.expressions,
        sanitized: false,
        chain: [fn],
        depth: 0,
        cost: 0,
        unresolvedParam: false,
        source: {
          symbolId: fn.symbolId,
          file: fn.file,
          line: seed.line,
          evidence: seed.evidence,
          kind: seed.kind,
        },
      });
    }
  }

  const paths = [...ctx.paths.values()].sort(
    (a, b) =>
      a.source.file.localeCompare(b.source.file) ||
      a.source.line - b.source.line ||
      a.sink.file.localeCompare(b.sink.file) ||
      a.sink.line - b.sink.line ||
      a.sink.rule.localeCompare(b.sink.rule) ||
      a.id.localeCompare(b.id),
  );
  return { paths, truncated: ctx.truncated, analysedSymbols: fnById.size };
}
