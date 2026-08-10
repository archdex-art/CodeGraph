import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disabledReport,
  fetchAdvisories,
  osvTransport,
  resolvePackages,
  type OsvTransport,
  type ResolvedPackage,
} from "../src/advisories";

/**
 * THE PROPERTY UNDER TEST is not "we find vulnerabilities" — it is that a failed check can
 * never be read as a clean one. Every failure mode below asserts `status` AND an empty list,
 * because the pair is what makes the two states distinguishable downstream.
 *
 * Nothing here touches the network: `fetchAdvisories` takes its transport by injection and the
 * tests hand it recorded OSV-shaped strings.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-advisories-"));
  trees.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (over: Partial<ResolvedPackage> & { name: string }): ResolvedPackage => ({
  version: "1.0.0",
  ecosystem: "npm",
  direct: true,
  approximate: false,
  ...over,
});

/** Full-form OSV vulnerability, as `/v1/query` returns it and as a hydrating proxy would. */
const LODASH_VULN = {
  id: "GHSA-p6mc-m468-83gg",
  summary: "Prototype pollution in lodash",
  details: "Long form details.\nSecond line.",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { name: "lodash", ecosystem: "npm" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
    },
  ],
  references: [
    { type: "WEB", url: "https://example.invalid/web" },
    { type: "ADVISORY", url: "https://github.com/advisories/GHSA-p6mc-m468-83gg" },
  ],
};

function batch(...perQuery: Array<{ vulns?: unknown[] }>): string {
  return JSON.stringify({ results: perQuery });
}

interface OsvBatchRequest {
  readonly queries: readonly unknown[];
}

/** The request body is built by `fetchAdvisories` itself, so its shape is an invariant of the
 *  module under test rather than external input — asserting it here is checked by the
 *  round-trip assertion in "sends the package name in the body only". */
function queriesIn(body: string): readonly unknown[] {
  const parsed = JSON.parse(body) as OsvBatchRequest;
  return parsed.queries;
}

const okTransport =
  (raw: string): OsvTransport =>
  () =>
    Promise.resolve(raw);

describe("mapping an OSV response", () => {
  it("maps a full vulnerability to severity, fixedIn and the advisory url", async () => {
    const report = await fetchAdvisories(
      [pkg({ name: "lodash", version: "4.17.15" })],
      okTransport(batch({ vulns: [LODASH_VULN] })),
    );

    expect(report.status).toBe("checked");
    expect(report.packagesQueried).toBe(1);
    expect(report.checkedAt).not.toBeNull();
    expect(report.advisories).toEqual([
      {
        id: "GHSA-p6mc-m468-83gg",
        package: "lodash",
        installedVersion: "4.17.15",
        severity: "high",
        summary: "Prototype pollution in lodash",
        fixedIn: "4.17.21",
        url: "https://github.com/advisories/GHSA-p6mc-m468-83gg",
        direct: true,
        approximateMatch: false,
      },
    ]);
  });

  it("reports unknown severity and no fix when querybatch abbreviates the vulnerability", async () => {
    // This is what the live batch endpoint actually returns. "unknown" must not be dressed up
    // as "low", and a missing fix must not be dressed up as "no fix exists".
    const report = await fetchAdvisories(
      [pkg({ name: "minimist", version: "1.2.0" })],
      okTransport(batch({ vulns: [{ id: "GHSA-xvch-5gv4-984h", modified: "2024-01-01T00:00:00Z" }] })),
    );

    const [advisory] = report.advisories;
    expect(report.status).toBe("checked");
    expect(advisory?.severity).toBe("unknown");
    expect(advisory?.fixedIn).toBeNull();
    expect(advisory?.summary).toContain("no summary");
    expect(advisory?.url).toBe("https://osv.dev/vulnerability/GHSA-xvch-5gv4-984h");
  });

  it("offers the lowest fix AHEAD of the installed version, never a downgrade", async () => {
    const twoLines = {
      id: "GHSA-two-lines",
      affected: [
        {
          package: { name: "pkg", ecosystem: "npm" },
          ranges: [
            { type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.4" }] },
            { type: "SEMVER", events: [{ introduced: "2.0.0" }, { fixed: "2.0.1" }] },
          ],
        },
      ],
    };
    const onV2 = await fetchAdvisories([pkg({ name: "pkg", version: "2.0.0" })], okTransport(batch({ vulns: [twoLines] })));
    const onV1 = await fetchAdvisories([pkg({ name: "pkg", version: "1.0.5" })], okTransport(batch({ vulns: [twoLines] })));

    expect(onV2.advisories[0]?.fixedIn).toBe("2.0.1");
    expect(onV1.advisories[0]?.fixedIn).toBe("1.2.4");
  });

  it("treats a package with no `vulns` key as clean", async () => {
    const report = await fetchAdvisories([pkg({ name: "left-pad" })], okTransport(batch({})));
    expect(report.status).toBe("checked");
    expect(report.advisories).toEqual([]);
    expect(report.reason).toBeNull();
  });

  it("attributes each result to its query by index", async () => {
    const report = await fetchAdvisories(
      [pkg({ name: "aaa" }), pkg({ name: "bbb", direct: false })],
      okTransport(batch({}, { vulns: [{ id: "OSV-1", database_specific: { severity: "LOW" } }] })),
    );
    expect(report.advisories.map((a) => a.package)).toEqual(["bbb"]);
  });

  it("orders advisories worst-first and deterministically", async () => {
    const sev = (id: string, severity: string) => ({ id, database_specific: { severity } });
    const report = await fetchAdvisories(
      [pkg({ name: "one" }), pkg({ name: "two" })],
      okTransport(
        batch(
          { vulns: [sev("OSV-b", "LOW"), sev("OSV-a", "CRITICAL")] },
          { vulns: [sev("OSV-c", "MODERATE")] },
        ),
      ),
    );
    expect(report.advisories.map((a) => [a.severity, a.id])).toEqual([
      ["critical", "OSV-a"],
      ["medium", "OSV-c"],
      ["low", "OSV-b"],
    ]);
  });
});

describe("a check that did not happen is never a clean check", () => {
  it("returns `unavailable` with a reason when the transport throws", async () => {
    const report = await fetchAdvisories([pkg({ name: "lodash" })], () =>
      Promise.reject(new Error("connect ETIMEDOUT")),
    );

    expect(report.status).toBe("unavailable");
    expect(report.reason).not.toBeNull();
    expect(report.reason).toContain("ETIMEDOUT");
    expect(report.advisories).toEqual([]);
    expect(report.checkedAt).toBeNull();
  });

  it("returns `unavailable` for an HTTP-error-shaped body that still parses as JSON", async () => {
    // The gRPC-gateway error shape. It has no `results`, so a lenient parser would emit an
    // empty advisory list and call the repository clean.
    const report = await fetchAdvisories(
      [pkg({ name: "lodash" })],
      okTransport(JSON.stringify({ code: 3, message: "invalid ecosystem" })),
    );

    expect(report.status).toBe("unavailable");
    expect(report.reason).toContain("invalid ecosystem");
    expect(report.advisories).toEqual([]);
  });

  it("returns `unavailable` for a non-JSON body such as a proxy error page", async () => {
    const report = await fetchAdvisories([pkg({ name: "lodash" })], okTransport("<html>504 Gateway Timeout</html>"));
    expect(report.status).toBe("unavailable");
    expect(report.reason).toContain("not JSON");
  });

  it("returns `unavailable` when result count does not match query count", async () => {
    // Index alignment is the only link between a vulnerability and its package.
    const report = await fetchAdvisories(
      [pkg({ name: "a" }), pkg({ name: "b" })],
      okTransport(batch({ vulns: [{ id: "OSV-1" }] })),
    );
    expect(report.status).toBe("unavailable");
    expect(report.advisories).toEqual([]);
  });

  it("discards advisories already collected when a later batch fails", async () => {
    // 150 packages is two requests; the second one dies. Half a list presented as a list is
    // the exact failure this module exists to prevent.
    const many = Array.from({ length: 150 }, (_, i) => pkg({ name: `p${String(i).padStart(3, "0")}` }));
    let call = 0;
    const flaky: OsvTransport = (body) => {
      call += 1;
      if (call === 1) {
        const queries = queriesIn(body);
        return Promise.resolve(batch(...queries.map(() => ({ vulns: [{ id: "OSV-early" }] }))));
      }
      return Promise.reject(new Error("socket hang up"));
    };

    const report = await fetchAdvisories(many, flaky);
    expect(call).toBe(2);
    expect(report.status).toBe("unavailable");
    expect(report.advisories).toEqual([]);
    expect(report.packagesQueried).toBe(0);
  });

  it("disabledReport is its own status, distinct from an empty checked report", () => {
    const report = disabledReport("CG_ADVISORIES disabled");
    expect(report).toEqual({
      status: "disabled",
      reason: "CG_ADVISORIES disabled",
      advisories: [],
      packagesQueried: 0,
      checkedAt: null,
    });
  });
});

describe("bounds", () => {
  it("enforces the package cap and says so in `reason`", async () => {
    const pkgs = Array.from({ length: 10 }, (_, i) => pkg({ name: `p${i}` }));
    let queried = 0;
    const counting: OsvTransport = (body) => {
      const queries = queriesIn(body);
      queried += queries.length;
      return Promise.resolve(batch(...queries.map(() => ({}))));
    };

    const report = await fetchAdvisories(pkgs, counting, { maxPackages: 3 });
    expect(queried).toBe(3);
    expect(report.packagesQueried).toBe(3);
    expect(report.status).toBe("checked");
    expect(report.reason).toContain("7 of 10 packages skipped");
  });

  it("chunks large package sets into several bounded requests", async () => {
    const pkgs = Array.from({ length: 250 }, (_, i) => pkg({ name: `p${String(i).padStart(3, "0")}` }));
    const sizes: number[] = [];
    const counting: OsvTransport = (body) => {
      const queries = queriesIn(body);
      sizes.push(queries.length);
      return Promise.resolve(batch(...queries.map(() => ({}))));
    };

    const report = await fetchAdvisories(pkgs, counting);
    expect(sizes).toEqual([100, 100, 50]);
    expect(report.packagesQueried).toBe(250);
  });

  it("never queries a package with no resolvable version, and admits the gap", async () => {
    let queried = 0;
    const counting: OsvTransport = (body) => {
      const queries = queriesIn(body);
      queried += queries.length;
      return Promise.resolve(batch(...queries.map(() => ({}))));
    };

    const report = await fetchAdvisories(
      [pkg({ name: "known", version: "1.0.0" }), pkg({ name: "starred", version: null, approximate: true })],
      counting,
    );
    expect(queried).toBe(1);
    expect(report.packagesQueried).toBe(1);
    expect(report.reason).toContain("1 packages had no resolvable version");
  });

  it("sends the package name in the body only — the caller never composes a URL", async () => {
    const seen: string[] = [];
    const capture: OsvTransport = (body) => {
      seen.push(body);
      return Promise.resolve(batch({}));
    };
    await fetchAdvisories([pkg({ name: "@scope/weird name", version: "1.2.3" })], capture);
    expect(JSON.parse(seen[0] ?? "{}")).toEqual({
      queries: [{ package: { name: "@scope/weird name", ecosystem: "npm" }, version: "1.2.3" }],
    });
  });
});

describe("resolvePackages", () => {
  it("prefers the locked version over the manifest range", () => {
    const root = repo({
      "package.json": { name: "app", dependencies: { lodash: "^4.17.0" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.21" } },
      },
    });

    expect(resolvePackages(root)).toEqual([
      { name: "lodash", version: "4.17.21", ecosystem: "npm", direct: true, approximate: false },
    ]);
  });

  it("falls back to the range floor and marks it approximate", () => {
    const root = repo({ "package.json": { name: "app", dependencies: { lodash: "^4.17.0" } } });

    expect(resolvePackages(root)).toEqual([
      { name: "lodash", version: "4.17.0", ecosystem: "npm", direct: true, approximate: true },
    ]);
  });

  it("yields a null version for a range with no concrete floor", () => {
    // `*` would make OSV return every vulnerability the package ever had, which reads exactly
    // like a set of live findings. Null keeps it out of the query and into `reason`.
    const root = repo({
      "package.json": { name: "app", dependencies: { anything: "*", tagged: "latest", forked: "git+ssh://x/y" } },
    });

    expect(resolvePackages(root).map((p) => [p.name, p.version])).toEqual([
      ["anything", null],
      ["forked", null],
      ["tagged", null],
    ]);
  });

  it("marks a lockfile-only package transitive and a declared one direct", () => {
    const root = repo({
      "package.json": { name: "app", dependencies: { express: "^4.18.0" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          "node_modules/express": { version: "4.18.2" },
          "node_modules/express/node_modules/qs": { version: "6.11.0" },
        },
      },
    });

    expect(resolvePackages(root).map((p) => [p.name, p.version, p.direct])).toEqual([
      ["express", "4.18.2", true],
      ["qs", "6.11.0", false],
    ]);
  });

  it("reads a lockfileVersion 1 dependency tree", () => {
    const root = repo({
      "package.json": { name: "app", dependencies: { express: "^4.18.0" } },
      "package-lock.json": {
        lockfileVersion: 1,
        dependencies: {
          express: { version: "4.18.2", dependencies: { qs: { version: "6.11.0" } } },
        },
      },
    });

    expect(resolvePackages(root).map((p) => [p.name, p.version, p.direct])).toEqual([
      ["express", "4.18.2", true],
      ["qs", "6.11.0", false],
    ]);
  });

  it("keeps every locked copy of a package, not just the top-level one", () => {
    // Collapsing these would silently un-check a vulnerable nested copy.
    const root = repo({
      "package.json": { name: "app", dependencies: {} },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          "node_modules/semver": { version: "7.5.4" },
          "node_modules/old-tool/node_modules/semver": { version: "5.7.1" },
        },
      },
    });

    expect(resolvePackages(root).map((p) => p.version)).toEqual(["5.7.1", "7.5.4"]);
  });

  it("aggregates nested workspace manifests and excludes workspace-internal names", () => {
    const root = repo({
      "package.json": { name: "root", workspaces: ["packages/*"], dependencies: { "@x/a": "*" } },
      "packages/a/package.json": { name: "@x/a", dependencies: { "@x/b": "*", lodash: "^4.17.21" } },
      "packages/b/package.json": { name: "@x/b", devDependencies: { vitest: "^3.2.4" } },
    });

    expect(resolvePackages(root).map((p) => p.name)).toEqual(["lodash", "vitest"]);
  });

  it("ignores an installed tree and a nested clone", () => {
    const root = repo({
      "package.json": { name: "app", dependencies: { lodash: "^4.17.21" } },
      "node_modules/evil/package.json": { name: "evil", dependencies: { "not-ours": "^1.0.0" } },
      "vendor/clone/package.json": { name: "clone", dependencies: { "also-not-ours": "^1.0.0" } },
    });

    expect(resolvePackages(root).map((p) => p.name)).toEqual(["lodash"]);
  });

  it("survives an unparseable manifest and an unparseable lockfile", () => {
    const root = repo({
      "package.json": "{ this is not json",
      "packages/a/package.json": { name: "@x/a", dependencies: { zod: "^3.0.0" } },
      "package-lock.json": "}}}",
    });

    expect(resolvePackages(root).map((p) => [p.name, p.version, p.approximate])).toEqual([
      ["zod", "3.0.0", true],
    ]);
  });

  it("returns an empty list for a repository with no manifest at all", () => {
    expect(resolvePackages(repo({ "src/main.go": "package main\n" }))).toEqual([]);
  });
});

describe("end to end, still without a network", () => {
  it("carries `approximateMatch` from a range-only resolution into the advisory", async () => {
    const root = repo({ "package.json": { name: "app", dependencies: { lodash: "^4.17.0" } } });
    const pkgs = resolvePackages(root);
    expect(pkgs[0]?.approximate).toBe(true);

    const report = await fetchAdvisories(pkgs, okTransport(batch({ vulns: [LODASH_VULN] })));
    const [advisory] = report.advisories;
    expect(advisory?.approximateMatch).toBe(true);
    expect(advisory?.installedVersion).toBe("4.17.0");
    // The installed version is a guess, so the fix must not be filtered against it.
    expect(advisory?.fixedIn).toBe("4.17.21");
  });

  it("a locked resolution produces an exact match", async () => {
    const root = repo({
      "package.json": { name: "app", dependencies: { lodash: "^4.17.0" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.15" } },
      },
    });

    const report = await fetchAdvisories(resolvePackages(root), okTransport(batch({ vulns: [LODASH_VULN] })));
    expect(report.advisories[0]?.approximateMatch).toBe(false);
    expect(report.advisories[0]?.installedVersion).toBe("4.17.15");
  });
});

describe("the real transport, with `fetch` stubbed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Every call records what the transport asked for, so the URL claim is asserted, not assumed. */
  function stubFetch(respond: () => Response): Array<{ url: string; init: RequestInit }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    });
    return calls;
  }

  it("posts to the constant URL and puts repository data only in the body", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ results: [{}] }), { status: 200 }));
    const body = JSON.stringify({ queries: [{ package: { name: "../../etc/passwd", ecosystem: "npm" } }] });

    await expect(osvTransport()(body)).resolves.toBe(JSON.stringify({ results: [{}] }));
    expect(calls[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(body);
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("throws on a non-2xx response so the report becomes `unavailable`", async () => {
    stubFetch(() => new Response("rate limited", { status: 429, statusText: "Too Many Requests" }));
    await expect(osvTransport()("{}")).rejects.toThrow("429");
  });

  it("refuses a response that declares more bytes than the cap", async () => {
    stubFetch(
      () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } }),
    );
    await expect(osvTransport()("{}")).rejects.toThrow(/cap/);
  });

  it("aborts a response that streams past the cap without declaring it", async () => {
    // No `content-length`, so only the streaming counter can stop this one.
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 8; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    stubFetch(() => new Response(oversized, { status: 200 }));
    await expect(osvTransport()("{}")).rejects.toThrow(/cap/);
  });
});
