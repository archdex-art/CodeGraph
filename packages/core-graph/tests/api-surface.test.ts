import { beforeAll, describe, expect, it } from "vitest";
import {
  buildApiSurface,
  endpointsAffectedBy,
  extractEndpoints,
  unauthenticatedSinkPaths,
} from "../src/api";
import type { ApiEndpoint, ApiSurface } from "../src/api";
import { buildSymbolGraph } from "../src/index";
import type { SymbolGraph } from "../src/symbol";

/**
 * The API surface, on sources that are real enough to be indexed.
 *
 * Every fixture below goes through `buildSymbolGraph` rather than a hand-built
 * graph, because the two failure modes this module actually has are (a) a route
 * path derived by string surgery that disagrees with what Next serves and (b) a
 * handler id synthesised from our own line counting that no graph symbol
 * matches. A stub graph hides both.
 */
const f = (rel: string, text: string) => ({ rel, ext: ".ts", text, language: "TypeScript" });

// A guarded Next route whose handler reaches a db-tagged symbol two hops down.
const INTEL_ROUTE = `
export function repoAccessDenied(req: unknown) {
  return req === null ? "denied" : null;
}
/** Reads one repo row out of the database. */
export function queryRepos(id: string) {
  return { id };
}
export function loadIntel(id: string) {
  return queryRepos(id);
}
export async function GET(req: unknown, id: string) {
  const denied = repoAccessDenied(req);
  if (denied) return denied;
  return loadIntel(id);
}
`;

// Same framework, no guard anywhere in the handler's reach.
const REPORTS_ROUTE = `
export function runQuery(row: string) {
  return row;
}
export function writeReport(row: string) {
  return runQuery(row);
}
export async function POST(row: string) {
  return writeReport(row);
}
`;

const DOCS_ROUTE = `
export function GET(slug: string) {
  return slug;
}
`;

const ROOT_ROUTE = `
export function HEAD() {
  return null;
}
`;

// Express: a mounted child router, a literal path, a non-literal path, and a
// network sink that must NOT surface as a security finding.
const EXPRESS_ROUTES = `
import express from "express";

const ADMIN_PATH = "/admin";
const router = express.Router();
const app = express();

export function findManyItems(q: string) {
  return q;
}
export function listItems(q: string) {
  return findManyItems(q);
}
export function fetchUpstream(q: string) {
  return q;
}
export function proxyItems(q: string) {
  return fetchUpstream(q);
}
export function spawnWorker(q: string) {
  return q;
}
export function adminHandler(q: string) {
  return spawnWorker(q);
}

router.get("/items", listItems);
router.get("/proxy", proxyItems);
router.get(ADMIN_PATH, adminHandler);
app.use("/api", router);
`;

const EXPRESS_ANON = `
import express from "express";
const app = express();
app.get("/anon", (req: unknown, res: { end: () => void }) => res.end());
`;

const EXPRESS_TEMPLATE = `
import express from "express";
const app = express();
const dir = "docs";

export function readFileSafe(p: string) {
  return p;
}
export function serveFile(p: string) {
  return readFileSafe(p);
}

app.get(\`/files/\${dir}\`, serveFile);
`;

const FILES = [
  f("apps/web/src/app/api/repos/[id]/intel/route.ts", INTEL_ROUTE),
  f("apps/web/src/app/api/reports/route.ts", REPORTS_ROUTE),
  f("apps/web/src/app/(marketing)/docs/[...slug]/route.ts", DOCS_ROUTE),
  f("src/app/route.ts", ROOT_ROUTE),
  f("server/routes.ts", EXPRESS_ROUTES),
  f("server/anon.ts", EXPRESS_ANON),
  f("server/template.ts", EXPRESS_TEMPLATE),
];

let graph: SymbolGraph;
let raw: ApiEndpoint[];
let surface: ApiSurface;

const byId = (s: ApiSurface, id: string): ApiEndpoint => {
  const hit = s.endpoints.find((e) => e.id === id);
  if (!hit) throw new Error(`no endpoint ${id} in ${s.endpoints.map((e) => e.id).join(", ")}`);
  return hit;
};

beforeAll(async () => {
  graph = await buildSymbolGraph(FILES, new Map());
  raw = extractEndpoints(FILES);
  surface = buildApiSurface(raw, graph);
});

describe("route path derivation", () => {
  it("turns a Next app-router directory into the path Next serves", () => {
    // The `apps/` prefix is a decoy: stripping at the FIRST `app` segment yields
    // `/web/src/app/api/...`, which is not a URL this server answers on.
    expect(raw.some((e) => e.id === "GET /api/repos/:id/intel")).toBe(true);
  });

  it("drops route groups and collapses a catch-all", () => {
    expect(raw.some((e) => e.id === "GET /docs/*")).toBe(true);
  });

  it("names the root route file `/`", () => {
    expect(raw.some((e) => e.id === "HEAD /")).toBe(true);
  });

  it("marks Next paths as static, since they come from the filesystem", () => {
    expect(byId(surface, "GET /api/repos/:id/intel").pathIsDynamic).toBe(false);
  });
});

describe("express-style registration", () => {
  it("applies a same-file literal `use` prefix to the child router's routes", () => {
    const ep = byId(surface, "GET /api/items");
    expect(ep.routePath).toBe("/api/items");
    expect(ep.framework).toBe("express");
    expect(ep.pathIsDynamic).toBe(false);
  });

  it("keeps a non-literal path, marked dynamic, with the literal prefix it does know", () => {
    // Dropping it would silently shrink the attack surface; inventing `/admin`
    // from the const's initialiser would claim a resolution we did not do.
    const dyn = raw.filter((e) => e.pathIsDynamic && e.file === "server/routes.ts");
    expect(dyn).toHaveLength(1);
    expect(dyn[0]!.pathIsDynamic).toBe(true);
    expect(dyn[0]!.routePath).toBe("/api");
  });

  it("keeps a template path's static chunks and marks it dynamic", () => {
    const ep = raw.find((e) => e.file === "server/template.ts")!;
    expect(ep.routePath).toBe("/files/*");
    expect(ep.pathIsDynamic).toBe(true);
  });

  it("resolves a named function argument to its graph symbol", () => {
    const listItems = graph.symbols.find(
      (s) => s.name === "listItems" && s.file === "server/routes.ts",
    )!;
    expect(byId(surface, "GET /api/items").handlerSymbolId).toBe(listItems.id);
  });

  it("does not mistake a Map read for a route registration", () => {
    const eps = extractEndpoints([
      f("m.ts", "const cache = new Map<string, string>();\nconst v = cache.get(key, fallback);\n"),
    ]);
    expect(eps).toHaveLength(0);
  });
});

describe("handler resolution and auth", () => {
  it("resolves a Next handler to the exported symbol named after the method", () => {
    const get = graph.symbols.find(
      (s) => s.name === "GET" && s.file === "apps/web/src/app/api/repos/[id]/intel/route.ts",
    )!;
    expect(byId(surface, "GET /api/repos/:id/intel").handlerSymbolId).toBe(get.id);
  });

  it("reports `true` with the guard it found, not a bare boolean", () => {
    const ep = byId(surface, "GET /api/repos/:id/intel");
    expect(ep.authenticated).toBe(true);
    expect(ep.authEvidence).toContain("repoAccessDenied");
  });

  it("reports `false` only when the handler resolved and its reach held no guard", () => {
    const ep = byId(surface, "POST /api/reports");
    expect(ep.handlerSymbolId).not.toBeNull();
    expect(ep.authenticated).toBe(false);
    expect(ep.authEvidence).toBeNull();
  });

  it("reports `null`, never `false`, for an unresolvable inline handler", () => {
    // The distinction is the product: `false` here would manufacture a finding
    // about a route whose handler we never even located.
    const ep = byId(surface, "GET /anon");
    expect(ep.handlerSymbolId).toBeNull();
    expect(ep.authenticated).toBeNull();
    expect(ep.authenticated).not.toBe(false);
  });
});

describe("data flow to sinks", () => {
  it("traces endpoint -> service -> db with the whole hop chain", () => {
    const flow = surface.flows.find(
      (fl) => fl.endpointId === "GET /api/repos/:id/intel" && fl.sink.kind === "database",
    )!;
    expect(flow).toBeDefined();
    expect(flow.hops.map((h) => h.name)).toEqual(["GET", "loadIntel", "queryRepos"]);
    expect(flow.hops[0]!.file).toBe("apps/web/src/app/api/repos/[id]/intel/route.ts");
    expect(flow.sink.symbolId).toBe(flow.hops[flow.hops.length - 1]!.symbolId);
    // The graph's `db` tag outranks a name token, so the evidence names the
    // symbol; a token match would have reported the bare word "query" instead.
    expect(flow.sink.evidence).toContain("queryRepos");
  });

  it("classifies a sink by name when no tag applies", () => {
    const flow = surface.flows.find((fl) => fl.sink.symbolId.includes("findManyItems"))!;
    expect(flow.sink.kind).toBe("database");
    expect(flow.sink.evidence).toBe("findMany");
    expect(flow.hops.map((h) => h.name)).toEqual(["listItems", "findManyItems"]);
  });

  it("separates filesystem, process and network sinks", () => {
    const kinds = new Map(surface.flows.map((fl) => [fl.sink.symbolId, fl.sink.kind]));
    const kindOf = (needle: string) => {
      for (const [id, kind] of kinds) if (id.includes(needle)) return kind;
      return null;
    };
    expect(kindOf("readFileSafe")).toBe("filesystem");
    expect(kindOf("spawnWorker")).toBe("process");
    expect(kindOf("fetchUpstream")).toBe("network");
  });

  it("stays untruncated on an input this small", () => {
    expect(surface.truncated).toBe(false);
  });
});

describe("endpointsAffectedBy", () => {
  it("finds the endpoints whose handler reaches a changed symbol", () => {
    const findMany = graph.symbols.find((s) => s.name === "findManyItems")!;
    expect(endpointsAffectedBy(surface, graph, findMany.id).map((e) => e.id)).toEqual([
      "GET /api/items",
    ]);
  });

  it("counts the handler itself as affected", () => {
    const get = graph.symbols.find(
      (s) => s.name === "GET" && s.file === "apps/web/src/app/api/repos/[id]/intel/route.ts",
    )!;
    expect(endpointsAffectedBy(surface, graph, get.id).map((e) => e.id)).toEqual([
      "GET /api/repos/:id/intel",
    ]);
  });

  it("returns nothing for a symbol no endpoint reaches", () => {
    const orphan = graph.symbols.find((s) => s.name === "HEAD")!;
    const hit = endpointsAffectedBy(surface, graph, orphan.id).map((e) => e.id);
    expect(hit).toEqual(["HEAD /"]); // its own handler, and nothing else
  });
});

describe("unauthenticatedSinkPaths", () => {
  it("returns only db/fs/process flows from endpoints proven guardless", () => {
    const paths = unauthenticatedSinkPaths(surface);
    const seen = paths.map((p) => `${p.endpointId} -> ${p.sink.kind}`).sort();
    expect(seen).toEqual([
      "GET /api -> process",
      "GET /api/items -> database",
      "GET /files/* -> filesystem",
      "POST /api/reports -> database",
    ]);
  });

  it("excludes the guarded endpoint's database flow", () => {
    const paths = unauthenticatedSinkPaths(surface);
    expect(paths.some((p) => p.endpointId === "GET /api/repos/:id/intel")).toBe(false);
  });

  it("excludes an endpoint we could not resolve a handler for", () => {
    // `null` must never be swept into the finding list alongside `false`.
    const paths = unauthenticatedSinkPaths(surface);
    expect(paths.some((p) => p.endpointId === "GET /anon")).toBe(false);
  });
});
