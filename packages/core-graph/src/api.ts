import ts from "typescript";
import { QueryEngine } from "./query";
import type { CodeSymbol, SymbolGraph } from "./symbol";

/**
 * The HTTP surface: which endpoints a repository exposes, what each one can
 * reach, and whether anything guards it.
 *
 * **What this cannot see.** Routes are recognised syntactically, from the
 * filesystem layout (Next app router) or from a `x.get("/p", h)` call shape
 * (Express/Koa/Fastify). A router assembled at runtime - a table of paths fed
 * through a loop, a path built from an imported constant, a framework wrapper
 * that registers handlers for you - is either recorded with `pathIsDynamic:
 * true` and whatever literal text was actually present, or not seen at all.
 * Nothing here proves an endpoint list is COMPLETE, only that the listed ones
 * exist.
 *
 * **Why `authenticated` is `boolean | null` and not `boolean`.** The whole
 * value of an auth column is telling "this route is open" apart from "we could
 * not follow this route's handler". Collapsing the second into `false` invents
 * findings; collapsing it into `true` hides them. So an unresolved handler -
 * an inline arrow the graph has no symbol for, a handler defined in a file that
 * was not indexed - yields `null`, and `false` is claimed only when a handler
 * symbol WAS resolved and its bounded reachable set genuinely contained no
 * guard. `false` is still bounded, not proven: a guard eight calls deep, or
 * applied as framework middleware rather than called from the handler, reads as
 * `false` here. That is the known cost of a depth-capped call-graph walk, and
 * it is why `unauthenticatedSinkPaths` is a triage list, not a verdict.
 */

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ANY";

export type ApiSinkKind = "database" | "filesystem" | "network" | "process";

export interface ApiEndpoint {
  /** `${method} ${routePath}`. Stable across runs; two registrations of the same
   *  pair collapse to one endpoint, which is what a caller of the API sees. */
  readonly id: string;
  readonly method: ApiMethod;
  readonly routePath: string;
  readonly file: string;
  readonly line: number;
  readonly framework: string;
  readonly handlerSymbolId: string | null;
  /** True when the registered path was not a string literal. `routePath` then
   *  holds the best literal text available (a mount prefix, a template's static
   *  chunks) and never a guessed completion. */
  readonly pathIsDynamic: boolean;
  /** `null` = we could not tell, NOT "no guard". See the module comment. */
  readonly authenticated: boolean | null;
  readonly authEvidence: string | null;
}

export interface DataFlowPath {
  readonly endpointId: string;
  /** The call chain, `hops[0]` the handler and the last hop the sink symbol. */
  readonly hops: ReadonlyArray<{ symbolId: string; name: string; file: string; line: number }>;
  readonly sink: { kind: ApiSinkKind; symbolId: string; evidence: string };
}

export interface ApiSurface {
  readonly endpoints: readonly ApiEndpoint[];
  readonly flows: readonly DataFlowPath[];
  /** A cap was hit somewhere: the answer is a prefix of the truth, not the truth. */
  readonly truncated: boolean;
}

/** Files are the same `{ rel, ext, text, language }` shape `buildSymbolGraph` takes. */
export interface ApiSourceFile {
  readonly rel: string;
  readonly ext: string;
  readonly text: string;
  readonly language: string;
}

// Inputs are attacker-authored repositories, so every unbounded dimension gets a
// ceiling. Each of these is a refusal to work, recorded as `truncated`, not a
// silent shrug.
const MAX_SOURCE_BYTES = 512 * 1024; // a 5 MB generated bundle is not a route file
const MAX_NODES_PER_FILE = 200_000; // AST visits; a pathological file stops mid-walk
const MAX_AST_DEPTH = 400; // guards the recursive walk's own stack
const MAX_ENDPOINTS = 2_000;
const MAX_ROUTE_SEGMENTS = 24; // deepest `app/` nesting we will name
const MAX_REACH_DEPTH = 4; // call hops walked from a handler, both directions
const MAX_FLOWS_PER_ENDPOINT = 8;
const MAX_FLOWS = 500;
const MAX_HANDLER_CANDIDATES = 64; // same-name declarations considered when resolving

const HTTP_METHODS = new Map<string, ApiMethod>(Object.entries({
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  HEAD: "HEAD",
  OPTIONS: "OPTIONS",
}));

/** Lowercase registration methods on an Express/Koa/Fastify router. */
const ROUTER_METHODS = new Map<string, ApiMethod>(Object.entries({
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  del: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
  all: "ANY",
}));

/**
 * Names a router-ish object may end with. Without this `map.get("k")` and
 * `cache.delete(key)` register endpoints - the call shape is identical. The
 * cost is a router held in a variable named `r`, which the literal-path branch
 * in `routerCallTarget` catches instead.
 */
const ROUTER_OBJECT_SUFFIXES = ["app", "router", "fastify", "server", "api"] as const;

/**
 * Ordered: the first token a symbol name contains wins, so `executeQuery` is a
 * database sink rather than a process one. Matching is substring and
 * case-insensitive, which over-approximates - `requestLogger` reads as a
 * network sink - in the direction of showing a reviewer too much rather than
 * too little.
 */
const SINK_EVIDENCE: ReadonlyArray<{ kind: ApiSinkKind; token: string }> = [
  { kind: "database", token: "query" },
  { kind: "database", token: "findMany" },
  { kind: "database", token: "knex" },
  { kind: "filesystem", token: "readFile" },
  { kind: "filesystem", token: "writeFile" },
  { kind: "filesystem", token: "unlink" },
  { kind: "network", token: "fetch" },
  { kind: "network", token: "request" },
  { kind: "process", token: "execFile" },
  { kind: "process", token: "spawn" },
  { kind: "database", token: "execute" },
  { kind: "process", token: "exec" },
];

/** Guard names, matched on the whole symbol name, lowercased. */
const GUARD_NAMES = new Map<string, true>(Object.entries({
  requireworkspace: true,
  repoaccessdenied: true,
  getsession: true,
  requireauth: true,
  authenticate: true,
  isauthorized: true,
  verifytoken: true,
  checkauth: true,
}));

const NEXT_ROUTE_FILE = /^route\.(ts|tsx|js|mjs)$/;

/** Sinks worth waking a reviewer for: a read-only `fetch` is not one. */
const SINK_KINDS_WORTH_REPORTING: Record<ApiSinkKind, boolean> = {
  database: true,
  filesystem: true,
  process: true,
  network: false,
};

interface DeclSite {
  readonly file: string;
  readonly line: number;
}

interface ParsedFile {
  readonly rel: string;
  readonly sf: ts.SourceFile;
  /** Top-level and nested named declarations, name -> first line seen. */
  readonly decls: Map<string, number>;
  readonly framework: string;
}

const symId = (file: string, name: string, line: number) => `${file}#${name}@${line}`;

const lineAt = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function scriptKindFor(ext: string): ts.ScriptKind | null {
  switch (ext.toLowerCase()) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return null;
  }
}

/** Depth- and count-bounded pre-order walk. Returns false once a cap trips. */
function walk(sf: ts.SourceFile, visit: (n: ts.Node) => void): void {
  let budget = MAX_NODES_PER_FILE;
  const descend = (node: ts.Node, depth: number): void => {
    if (budget <= 0 || depth > MAX_AST_DEPTH) return;
    budget--;
    visit(node);
    ts.forEachChild(node, (c) => descend(c, depth + 1));
  };
  ts.forEachChild(sf, (c) => descend(c, 1));
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!mods) return false;
  for (const m of mods) if (m.kind === ts.SyntaxKind.ExportKeyword) return true;
  return false;
}

function parseFiles(files: ReadonlyArray<ApiSourceFile>): ParsedFile[] {
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    const kind = scriptKindFor(file.ext);
    if (kind === null) continue;
    if (file.text.length > MAX_SOURCE_BYTES) continue;
    const sf = ts.createSourceFile(file.rel, file.text, ts.ScriptTarget.Latest, true, kind);

    const decls = new Map<string, number>();
    let framework = "express";
    let frameworkPinned = false;
    walk(sf, (node) => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name &&
        !decls.has(node.name.text)
      ) {
        decls.set(node.name.text, lineAt(sf, node));
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !decls.has(node.name.text)
      ) {
        decls.set(node.name.text, lineAt(sf, node));
      } else if (!frameworkPinned && ts.isImportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (ts.isStringLiteral(spec)) {
          const m = spec.text.toLowerCase();
          if (m.includes("fastify")) {
            framework = "fastify";
            frameworkPinned = true;
          } else if (m.includes("koa")) {
            framework = "koa";
            frameworkPinned = true;
          } else if (m.includes("express")) {
            framework = "express";
            frameworkPinned = true;
          }
        }
      }
    });

    parsed.push({ rel: file.rel, sf, decls, framework });
  }
  return parsed;
}

/**
 * `apps/web/src/app/api/repos/[id]/intel/route.ts` -> `/api/repos/:id/intel`.
 * Returns null when the file is not a Next app-router route file.
 */
function nextRoutePath(rel: string): string | null {
  const segments = rel.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last || !NEXT_ROUTE_FILE.test(last)) return null;

  // Last `app` segment, not the first: `apps/web/src/app/...` has a decoy prefix,
  // and a route group could legitimately be named after an outer directory.
  let appAt = -1;
  for (let i = 0; i < segments.length - 1; i++) if (segments[i] === "app") appAt = i;
  if (appAt < 0) return null;

  const out: string[] = [];
  for (let i = appAt + 1; i < segments.length - 1; i++) {
    if (out.length >= MAX_ROUTE_SEGMENTS) return null;
    const seg = segments[i]!;
    if (seg.startsWith("(") && seg.endsWith(")")) continue; // route group: not in the URL
    if (seg.startsWith("[[...") && seg.endsWith("]]")) out.push("*");
    else if (seg.startsWith("[...") && seg.endsWith("]")) out.push("*");
    else if (seg.startsWith("[") && seg.endsWith("]")) out.push(`:${seg.slice(1, -1)}`);
    else out.push(seg);
  }
  return out.length === 0 ? "/" : `/${out.join("/")}`;
}

/** Next handlers are the file's exported `GET`/`POST`/... bindings. */
function nextEndpoints(pf: ParsedFile, routePath: string): ApiEndpoint[] {
  const found: ApiEndpoint[] = [];
  const record = (method: ApiMethod, line: number, handlerLine: number | null): void => {
    found.push({
      id: `${method} ${routePath}`,
      method,
      routePath,
      file: pf.rel,
      line,
      framework: "next-app-router",
      handlerSymbolId: handlerLine === null ? null : symId(pf.rel, method, handlerLine),
      pathIsDynamic: false, // derived from the filesystem; there is no expression to be dynamic
      authenticated: null,
      authEvidence: null,
    });
  };

  for (const stmt of pf.sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
      const method = HTTP_METHODS.get(stmt.name.text);
      if (method) record(method, lineAt(pf.sf, stmt), lineAt(pf.sf, stmt));
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const method = HTTP_METHODS.get(d.name.text);
        if (method) record(method, lineAt(pf.sf, stmt), lineAt(pf.sf, d));
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      // `export { handleGet as GET }` - the exported NAME decides the method, the
      // local name decides which symbol the handler is.
      for (const spec of stmt.exportClause.elements) {
        const method = HTTP_METHODS.get(spec.name.text);
        if (!method) continue;
        const local = spec.propertyName ? spec.propertyName.text : spec.name.text;
        const declLine = pf.decls.get(local);
        found.push({
          id: `${method} ${routePath}`,
          method,
          routePath,
          file: pf.rel,
          line: lineAt(pf.sf, spec),
          framework: "next-app-router",
          handlerSymbolId: declLine === undefined ? null : symId(pf.rel, local, declLine),
          pathIsDynamic: false,
          authenticated: null,
          authEvidence: null,
        });
      }
    }
  }
  return found;
}

interface RouterCall {
  readonly objectName: string;
  readonly method: string;
  readonly call: ts.CallExpression;
}

/**
 * `x.get(...)` where `x` is an identifier and the call plausibly registers a
 * route, rather than reading a Map. Two accepting branches: a router-shaped
 * object name, or a literal path starting with `/`.
 */
function routerCallTarget(node: ts.Node): RouterCall | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  const method = callee.name.text;
  if (node.arguments.length < 2) return null; // a path and at least one handler

  const objectName = callee.expression.text;
  const lower = objectName.toLowerCase();
  const routerish = ROUTER_OBJECT_SUFFIXES.some((s) => lower === s || lower.endsWith(s));
  const first = node.arguments[0]!;
  const literalPath = ts.isStringLiteralLike(first) && first.text.startsWith("/");
  if (!routerish && !literalPath) return null;

  return { objectName, method, call: node };
}

/**
 * The literal text of a path argument. `null` for a wholly non-literal
 * expression; a template contributes its static chunks with `*` where a
 * substitution was, because that much IS in the source.
 */
function literalPathOf(arg: ts.Expression): string | null {
  if (ts.isStringLiteralLike(arg) && !ts.isTemplateExpression(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    let out = arg.head.text;
    for (const span of arg.templateSpans) out += `*${span.literal.text}`;
    return out;
  }
  return null;
}

function joinRoute(prefix: string, path: string): string {
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const b = path.startsWith("/") ? path : `/${path}`;
  const joined = `${a}${b}`;
  if (joined === "") return "/";
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

/** The nearest enclosing named declaration of `node`, or null at module scope. */
function enclosingDecl(sf: ts.SourceFile, node: ts.Node): { name: string; line: number } | null {
  let cur: ts.Node | undefined = node.parent;
  let depth = 0;
  while (cur && depth++ < MAX_AST_DEPTH) {
    if (
      (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isClassDeclaration(cur)) &&
      cur.name &&
      ts.isIdentifier(cur.name)
    ) {
      return { name: cur.name.text, line: lineAt(sf, cur) };
    }
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))
    ) {
      return { name: cur.name.text, line: lineAt(sf, cur) };
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Extract every endpoint we can name, from Next app-router files and from
 * Express/Koa/Fastify registration calls. Deterministic: sorted by endpoint id,
 * then by file and line for two registrations of the same method and path.
 */
export function extractEndpoints(files: ReadonlyArray<ApiSourceFile>): ApiEndpoint[] {
  const parsed = parseFiles(files);

  // Name -> declaration sites across the whole input, so `app.get("/x", listItems)`
  // can find `listItems` in the module that defines it.
  const globalDecls = new Map<string, DeclSite[]>();
  for (const pf of parsed) {
    for (const [name, line] of pf.decls) {
      const sites = globalDecls.get(name);
      if (sites) {
        if (sites.length < MAX_HANDLER_CANDIDATES) sites.push({ file: pf.rel, line });
      } else {
        globalDecls.set(name, [{ file: pf.rel, line }]);
      }
    }
  }

  const endpoints: ApiEndpoint[] = [];
  for (const pf of parsed) {
    if (endpoints.length >= MAX_ENDPOINTS) break;

    const routePath = nextRoutePath(pf.rel);
    if (routePath !== null) {
      for (const ep of nextEndpoints(pf, routePath)) {
        if (endpoints.length >= MAX_ENDPOINTS) break;
        endpoints.push(ep);
      }
      // A Next route file registers nothing else; skip the router scan so an
      // `app.get` in a helper inside it is not double-counted as an endpoint.
      continue;
    }

    // Pass 1: mounts. `router.use("/prefix", child)` gives `child`'s routes a prefix,
    // but only when the prefix is a literal in this same file - a prefix imported
    // from elsewhere is exactly the thing we must not guess at.
    const mounts = new Map<string, { prefix: string; parent: string }>();
    const calls: RouterCall[] = [];
    walk(pf.sf, (node) => {
      const rc = routerCallTarget(node);
      if (!rc) return;
      if (rc.method === "use") {
        const prefix = literalPathOf(rc.call.arguments[0]!);
        const child = rc.call.arguments[1];
        if (prefix !== null && prefix.startsWith("/") && child && ts.isIdentifier(child)) {
          if (!mounts.has(child.text)) mounts.set(child.text, { prefix, parent: rc.objectName });
        }
        return;
      }
      if (ROUTER_METHODS.get(rc.method)) calls.push(rc);
    });

    const prefixFor = (objectName: string): string => {
      let out = "";
      let cur = objectName;
      const seen = new Set<string>([cur]);
      for (let i = 0; i < 4; i++) {
        const m = mounts.get(cur);
        if (!m || seen.has(m.parent)) break;
        out = `${m.prefix}${out}`;
        seen.add(m.parent);
        cur = m.parent;
      }
      return out;
    };

    // Pass 2: the registrations themselves.
    for (const rc of calls) {
      if (endpoints.length >= MAX_ENDPOINTS) break;
      const method = ROUTER_METHODS.get(rc.method)!;
      const pathArg = rc.call.arguments[0]!;
      const literal = literalPathOf(pathArg);
      const dynamic = literal === null || ts.isTemplateExpression(pathArg);
      const prefix = prefixFor(rc.objectName);
      const routePathText = joinRoute(prefix, literal ?? "");

      const handlerArg = rc.call.arguments[rc.call.arguments.length - 1]!;
      let handlerSymbolId: string | null = null;
      if (ts.isIdentifier(handlerArg)) {
        const sites = globalDecls.get(handlerArg.text);
        const local = sites?.find((s) => s.file === pf.rel);
        const site = local ?? (sites ? [...sites].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))[0] : undefined);
        if (site) handlerSymbolId = symId(site.file, handlerArg.text, site.line);
      } else if (ts.isFunctionExpression(handlerArg) && handlerArg.name) {
        handlerSymbolId = symId(pf.rel, handlerArg.name.text, lineAt(pf.sf, handlerArg));
      } else {
        const encl = enclosingDecl(pf.sf, rc.call);
        if (encl) handlerSymbolId = symId(pf.rel, encl.name, encl.line);
      }

      endpoints.push({
        id: `${method} ${routePathText}`,
        method,
        routePath: routePathText,
        file: pf.rel,
        line: lineAt(pf.sf, rc.call),
        framework: pf.framework,
        handlerSymbolId,
        pathIsDynamic: dynamic,
        authenticated: null,
        authEvidence: null,
      });
    }
  }

  endpoints.sort(
    (a, b) =>
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line,
  );
  return endpoints;
}

/**
 * Reconcile a syntactically-built handler id against the graph.
 *
 * `extractEndpoints` knows the handler's file, name and the line the DECLARATION
 * starts on by its own reckoning; the extractor that built the graph may count
 * that line differently (leading decorators, an `export` on its own line). Rather
 * than duplicate the extractor's line rules, match on file+name and take the
 * nearest line. Returns null when nothing in the graph carries that name in that
 * file - which is the honest answer for an inline arrow handler.
 */
function reconcileHandler(graph: SymbolGraph, qe: QueryEngine, raw: string | null): string | null {
  if (raw === null) return null;
  if (qe.get(raw)) return raw;

  const hash = raw.indexOf("#");
  const at = raw.lastIndexOf("@");
  if (hash < 0 || at < hash) return null;
  const file = raw.slice(0, hash);
  const name = raw.slice(hash + 1, at);
  const line = Number(raw.slice(at + 1));
  if (!Number.isFinite(line)) return null;

  let best: CodeSymbol | null = null;
  for (const s of graph.symbols) {
    if (s.file !== file || s.name !== name) continue;
    if (!best || Math.abs(s.line - line) < Math.abs(best.line - line)) best = s;
  }
  return best ? best.id : null;
}

function sinkFor(sym: CodeSymbol): { kind: ApiSinkKind; evidence: string } | null {
  if (sym.tags.includes("db")) return { kind: "database", evidence: `${sym.name} (db tag)` };
  const lower = sym.name.toLowerCase();
  for (const { kind, token } of SINK_EVIDENCE) {
    if (lower.includes(token.toLowerCase())) return { kind, evidence: token };
  }
  return null;
}

/**
 * Resolve handlers, decide auth, and trace each endpoint's calls to a sink.
 *
 * The forward walk is `QueryEngine.reachableCallees` - the same traversal the
 * rest of the package uses for taint reachability - so an endpoint's reach and a
 * taint query's reach can never disagree about what "within N hops" means. The
 * per-flow hop chain is then rebuilt from that walk's hop distances using
 * `callers`, picking the lexicographically smallest parent at each step, so two
 * runs over the same graph produce the same chain.
 */
export function buildApiSurface(
  endpoints: readonly ApiEndpoint[],
  graph: SymbolGraph,
): ApiSurface {
  const qe = new QueryEngine(graph);
  const resolved: ApiEndpoint[] = [];
  const flows: DataFlowPath[] = [];
  let truncated = graph.truncated || endpoints.length >= MAX_ENDPOINTS;

  for (const ep of endpoints) {
    const handlerId = reconcileHandler(graph, qe, ep.handlerSymbolId);
    if (handlerId === null) {
      resolved.push({ ...ep, handlerSymbolId: null, authenticated: null, authEvidence: null });
      continue;
    }

    const reach = qe.reachableCallees(handlerId, MAX_REACH_DEPTH);
    const ordered = [...reach].sort(
      (a, b) => a.hops - b.hops || (a.symbol.id < b.symbol.id ? -1 : a.symbol.id > b.symbol.id ? 1 : 0),
    );

    let authEvidence: string | null = null;
    for (const { symbol } of ordered) {
      if (GUARD_NAMES.get(symbol.name.toLowerCase())) {
        authEvidence = symbol.name;
        break;
      }
      if (authEvidence === null && symbol.tags.includes("auth")) {
        authEvidence = `${symbol.name} (auth tag)`;
        // Keep scanning: an exact guard name is stronger evidence than a tag, and
        // reporting the weaker one when both exist makes the column harder to trust.
      }
    }

    const endpoint: ApiEndpoint = {
      ...ep,
      handlerSymbolId: handlerId,
      authenticated: authEvidence !== null,
      authEvidence,
    };
    resolved.push(endpoint);

    const dist = new Map<string, number>();
    for (const { symbol, hops } of reach) dist.set(symbol.id, hops);

    let perEndpoint = 0;
    for (const { symbol } of ordered) {
      const sink = sinkFor(symbol);
      if (!sink) continue;
      // The cap is tested only once a sink is in hand: tripping it on a
      // non-sink candidate would report `truncated` for an endpoint whose
      // flows were in fact all found, and a truncation flag that cries wolf is
      // worse than none.
      if (perEndpoint >= MAX_FLOWS_PER_ENDPOINT || flows.length >= MAX_FLOWS) {
        truncated = true;
        break;
      }

      const chain: string[] = [symbol.id];
      let cur = symbol.id;
      let d = dist.get(symbol.id)!;
      while (d > 1) {
        const parents = qe
          .callers(cur)
          .filter((p) => dist.get(p.id) === d - 1)
          .map((p) => p.id)
          .sort();
        const next = parents[0];
        if (next === undefined) break;
        chain.push(next);
        cur = next;
        d--;
      }
      if (d !== 1) continue; // the walk lost the trail; a partial chain would be a lie
      chain.push(handlerId);
      chain.reverse();

      const hops = chain.map((id) => {
        const s = qe.get(id)!;
        return { symbolId: s.id, name: s.name, file: s.file, line: s.line };
      });
      flows.push({ endpointId: endpoint.id, hops, sink: { ...sink, symbolId: symbol.id } });
      perEndpoint++;
    }
  }

  flows.sort(
    (a, b) =>
      (a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0) ||
      (a.sink.symbolId < b.sink.symbolId ? -1 : a.sink.symbolId > b.sink.symbolId ? 1 : 0),
  );
  return { endpoints: resolved, flows, truncated };
}

/**
 * Endpoints whose handler can reach `symbolId` within `MAX_REACH_DEPTH` call
 * hops - "if I change this function, which routes change behaviour". Bounded, so
 * absence from this list is not proof of independence.
 */
export function endpointsAffectedBy(
  surface: ApiSurface,
  graph: SymbolGraph,
  symbolId: string,
): ApiEndpoint[] {
  const qe = new QueryEngine(graph);
  const upstream = new Set<string>([symbolId]);
  for (const s of qe.impact(symbolId, MAX_REACH_DEPTH)) upstream.add(s.id);

  const hit = surface.endpoints.filter(
    (ep) => ep.handlerSymbolId !== null && upstream.has(ep.handlerSymbolId),
  );
  hit.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.line - b.line);
  return hit;
}

/**
 * The triage list: flows into a database, the filesystem or a subprocess from an
 * endpoint we resolved and found no guard on. `authenticated === null` is
 * deliberately excluded - an endpoint we could not follow is a gap in the
 * analysis, not a finding, and mixing the two is how a reviewer learns to ignore
 * the whole list.
 */
export function unauthenticatedSinkPaths(surface: ApiSurface): DataFlowPath[] {
  const open = new Set<string>();
  for (const ep of surface.endpoints) if (ep.authenticated === false) open.add(ep.id);
  return surface.flows.filter(
    (f) => open.has(f.endpointId) && SINK_KINDS_WORTH_REPORTING[f.sink.kind],
  );
}
