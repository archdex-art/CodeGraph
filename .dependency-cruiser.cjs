/**
 * Layering gate for the monorepo (HLD §6.1, LLD §1.1).
 *
 * This file is the mechanical half of the architecture: HLD §6.1's dependency
 * rule is only real because this runs in CI. Written data-driven rather than as
 * hand-rolled rule objects so that adding a package is one line in ALLOWED
 * instead of an edit in three places — the same reason the language registry is
 * a manifest (HLD G3).
 *
 * Direction of the arrow: a package may import ONLY the packages listed for it.
 * Anything absent is a violation, so a new dependency is a deliberate act
 * recorded here, not an accident that compiles.
 */

/** @type {Record<string, readonly string[]>} */
const ALLOWED = {
  // Bottom of the stack: pure types, zero deps, zero I/O (LLD §2).
  "core-domain": [],

  // Config sits directly above core-domain: everything that needs settings
  // needs it, so it must not depend on anything that could need settings.
  // Notably it may NOT import observability — logging a config error requires
  // config to be loaded, and that cycle is how fail-fast-at-boot stops being
  // fail-fast.
  config: ["core-domain"],

  observability: ["core-domain", "config"],

  fsx: ["core-domain", "config", "observability"],
  vcs: ["core-domain", "config", "observability", "fsx"],
  persistence: ["core-domain", "config", "observability"],
  jobs: ["core-domain", "config", "observability", "persistence"],

  "core-graph": ["core-domain"],
  sarif: ["core-domain"],
  "score-engine": ["core-domain"],

  "detect-engine": ["core-domain", "core-graph", "fsx", "observability", "config"],
  "detect-rules": ["core-domain", "detect-engine"],

  "remediate-engine": [
    "core-domain",
    "core-graph",
    "fsx",
    "vcs",
    "observability",
    "config",
    "verify",
    "sandbox",
  ],
  swarm: ["core-domain", "core-graph", "detect-engine", "observability"],

  // ── Added 2026-07-30. These EXISTED ON DISK WITH NO LAYER RULE, which is worse than a
  // wrong rule: `layerRules` is built from this map's keys, so a package absent here got no
  // constraint at all and could import anything. `verify` arrived in P3 and
  // `analysis`/`analysis-model` in P2, and each time the gate silently grew a hole exactly
  // where the new code went. The `every-package-is-constrained` rule below now fails when a
  // package on disk is missing from this map, so the gate cannot develop that blind spot
  // again.

  // The four-gate verification harness (LLD §7.2). Independent of detection ON PURPOSE — it
  // operates on a patch and a sandbox, which is what let P3 jump ahead of P5. Do not add a
  // detect-* or lang-* entry here without revisiting that.
  verify: ["core-domain", "config", "observability", "vcs"],

  // Process-execution mechanics for verification (see child-process-only-in-vcs below).
  sandbox: ["core-domain", "config", "observability", "verify"],

  // P2's transitional package, split by P5 per LLD §13.2.
  "score-engine": ["analysis-model"],
  viz: ["analysis-model"],
  imports: ["analysis-model"],
  "detect-engine": ["analysis-model", "core-graph", "core-domain", "score-engine"],
  analysis: ["core-domain", "core-graph", "config", "vcs", "analysis-model", "score-engine", "viz", "detect-engine", "imports"],
  "analysis-model": ["core-graph"],
};

/**
 * `lang-*` packages get one shared rule: a language plugin never learns the
 * engine's name (HLD G3 — a new language must be an additive change).
 */
const LANG_ALLOWED = ["core-domain"];

const pkgNames = Object.keys(ALLOWED);

/**
 * A package on disk that is MISSING from ALLOWED gets no layer rule and is therefore
 * unconstrained — it can import anything. That is exactly how `verify`, `analysis`, and
 * `analysis-model` sat outside this gate for two phases.
 *
 * Fail at config-load rather than emitting a rule, because a silent hole in the gate is worse
 * than a loud failure to start: an unconstrained package still shows "no dependency violations
 * found", which reads as a pass.
 */
{
  const fs = require("node:fs");
  const onDisk = fs
    .readdirSync(`${__dirname}/packages`, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("lang-"))
    .map((d) => d.name);
  const unconstrained = onDisk.filter((n) => !pkgNames.includes(n));
  if (unconstrained.length > 0) {
    throw new Error(
      `.dependency-cruiser.cjs: packages exist with no layer rule and are therefore ` +
        `unconstrained: ${unconstrained.join(", ")}. Add each to ALLOWED with the packages it ` +
        `may import (HLD §6.1). An absent entry is not a permissive default — it is a hole in ` +
        `the gate.`
    );
  }
}

/** Path pattern for a package's own sources. */
const pkgPath = (name) => `^packages/${name}/`;

/** The set of package source paths a given allowlist does NOT cover. */
const forbiddenTargets = (allowed) =>
  pkgNames
    .filter((n) => !allowed.includes(n))
    .map(pkgPath)
    // A package importing itself by relative path is fine; exclude self above.
    .concat(["^packages/lang-"]);

const layerRules = pkgNames.map((name) => ({
  name: `layer-${name}`,
  comment: `packages/${name} may only import: ${ALLOWED[name].join(", ") || "(nothing)"} (HLD §6.1)`,
  severity: "error",
  from: { path: pkgPath(name) },
  to: {
    path: forbiddenTargets([...ALLOWED[name], name]).join("|"),
  },
}));

module.exports = {
  forbidden: [
    ...layerRules,

    {
      name: "lang-packages-are-leaves",
      comment:
        "A lang-* package knows its own syntax and nothing about detection, " +
        "scoring, or storage (HLD §6.1, LLD §4). This is what makes a new " +
        "language an additive change.",
      severity: "error",
      from: { path: "^packages/lang-" },
      to: {
        path: pkgNames
          .filter((n) => !LANG_ALLOWED.includes(n))
          .map(pkgPath)
          .join("|"),
      },
    },

    {
      name: "no-package-imports-app",
      comment:
        "Nothing may import apps/* (HLD §6.1). A package reaching into an app " +
        "is the end of independent testability and the start of a cycle.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },

    {
      name: "no-cross-app-imports",
      comment:
        "Apps are deployment units, not libraries. Shared code belongs in a " +
        "package (HLD §6.1).",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },

    {
      name: "supervisor-loads-no-parser",
      comment:
        "The worker SUPERVISOR must not import the analysis packages. It holds the " +
        "job lease for the whole run, so if it loads a parser its own memory grows " +
        "with the work — and web-tree-sitter's WASM arena only ever grows " +
        "(postmortem 2026-07-10, ~26MB per parsed file). The entire point of " +
        "ADR-001's per-job child process is that the long-lived process never " +
        "touches a parser and the short-lived one dies with its heap. An import " +
        "here would not fail a test or a build; it would quietly restore the OOM " +
        "this architecture exists to remove, which is exactly the class of " +
        "regression a gate has to catch. src/execute.ts and src/handlers/** ARE " +
        "the child and may import freely.",
      severity: "error",
      from: {
        path: "^apps/worker/src/(main|start|supervise)\\.ts$",
      },
      to: {
        path: "^packages/(analysis|core-graph)/",
      },
    },

    {
      name: "no-deep-import-across-packages",
      comment:
        "src/index.ts is a package's ONLY public surface (LLD §1.1). Reaching " +
        "past it freezes another package's internals into your contract, which " +
        "is exactly what this refactor exists to undo. Relative imports inside " +
        "a package are unaffected — the $1 back-reference exempts self.",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$"],
      },
    },

    {
      name: "no-deep-import-from-app",
      comment:
        "An app consumes a package through its published entry point only " +
        "(LLD §1.1).",
      severity: "error",
      from: { path: "^apps/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: "^packages/[^/]+/src/index\\.ts$",
      },
    },

    {
      name: "raw-fs-only-in-io-packages",
      comment:
        "node:fs belongs to the three packages that exist to own I/O: fsx " +
        "(workspace containment, LLD §10.1), vcs (git working trees), and " +
        "persistence (creating the data dir before opening SQLite). LLD §1.1 " +
        "names exactly these three. Raw fs anywhere else is how path " +
        "containment gets re-implemented slightly wrong.",
      severity: "error",
      from: {
        path: "^packages/",
        pathNot: [
          "^packages/(fsx|vcs|persistence)/",
          // Two more named files, 2026-07-30. Same reasoning as the `analysis/indexer.ts`
          // exemption below — fsx's WorkspaceHandle is async by design (§10.1) and both of
          // these are synchronous throughout — plus one thing that is NOT true of that one:
          //
          //   `remediate-engine/apply.ts` WRITES. So the containment this rule protects is
          //   implemented explicitly in `containedPath()` there (path.resolve before the
          //   comparison, separator-suffixed prefix check) and covered by tests, rather than
          //   left to the caller. That is the specific failure the rule's comment warns
          //   about, so it is discharged in code instead of waived.
          //
          //   `sandbox/sandbox.ts` only ever reads two manifests to answer "is there a test
          //   script" and "is there a tsconfig", both under a root the caller supplied.
          "^packages/remediate-engine/src/apply\\.ts$",
          "^packages/sandbox/src/sandbox\\.ts$",
          // ONE file, named explicitly rather than exempting the package, so
          // anything else in `analysis` that reaches for fs still fails.
          //
          // This violation was not introduced by the LLD §13.2 move — it was
          // REVEALED by it. `indexer.ts` has always walked the tree with
          // readFileSync/readdirSync/statSync; it sat in `apps/web`, and this
          // rule is scoped `from: ^packages/`, so nothing ever looked. The gate
          // catching it on arrival is the gate working.
          //
          // Not fixed here because the fix is not mechanical: `fsx`'s
          // WorkspaceHandle is async by design (`read(rel): Promise<string>`,
          // §10.1) and this walk is synchronous throughout, so routing it through
          // fsx changes the pipeline's execution shape. P2 is structural
          // (HLD §17), and §13 already routes this code to `pipeline/enumerate`,
          // which is where the async conversion belongs.
          //
          // Worth stating why this is a lower-risk exemption than it looks: the
          // containment concern the rule exists for is handled at the boundary,
          // before this code runs — `vcs.resolveLocalDir` validates the root and
          // `cloneRepo` produces one. What `indexer.ts` does is bulk read-only
          // enumeration of an already-validated root. It writes nothing.
          "^packages/analysis/src/indexer\\.ts$",
        ],
      },
      to: { path: "^(node:)?fs(/promises)?$", dependencyTypes: ["core"] },
    },

    {
      name: "child-process-only-in-vcs",
      comment:
        "Only vcs and sandbox shell out. LLD §10.2 scoped this to vcs because git was the " +
        "only subprocess the design had — it predates P3's gate 2/3, which must run `tsc` " +
        "and the analysed repository's own test suite. AMENDED rather than worked around: " +
        "the alternative was a sandbox duplicated in apps/web and apps/cli (apps are outside " +
        "this rule), and duplicating process-isolation mechanics across two hosts is how the " +
        "timeout, the argv array, and the scrubbed env quietly diverge. sandbox owns the " +
        "MECHANICS; each app keeps its own POLICY on whether gate 3 may run at all.",
      severity: "error",
      from: { path: "^packages/", pathNot: "^packages/(vcs|sandbox)/" },
      to: { path: "^(node:)?child_process$", dependencyTypes: ["core"] },
    },

    {
      name: "sqlite-only-in-persistence",
      comment: "Only persistence speaks SQL (HLD §6, LLD §8).",
      severity: "error",
      from: { path: "^packages/", pathNot: "^packages/persistence/" },
      to: { path: "^(node:)?sqlite$", dependencyTypes: ["core"] },
    },

    {
      name: "no-unresolvable",
      comment:
        "An import that cannot be resolved. Two things land here: a plain typo, " +
        "and — the reason this rule was added — a DEEP import into another " +
        "package, e.g. `@codegraph/core-domain/src/fingerprint`. Because each " +
        "package's `exports` field publishes only `.` and `./package.json` " +
        "(LLD §1.1), a deep specifier is unresolvable rather than merely " +
        "discouraged, so the `no-deep-import-*` rules never see it and the gate " +
        "used to pass. Node and Turbopack both reject it at build time with " +
        "ERR_PACKAGE_PATH_NOT_EXPORTED, but a gate that only fails downstream is " +
        "a gate that wasted your time. Verified by introducing exactly that " +
        "import and watching this rule fire.",
      severity: "error",
      from: {
        // `next-env.d.ts` is generated by Next and gitignored, and it references
        // `next/image-types/global`, a virtual module that exists only inside
        // Next's own type resolution. Not our code, and not resolvable here.
        pathNot: "(^|/)next-env\\.d\\.ts$",
      },
      to: { couldNotResolve: true },
    },

    {
      name: "no-circular",
      comment:
        "A cycle is a build failure (HLD §6.1). Cycles are why v1's lib/ could " +
        "not be split without moving everything at once.",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    // `no-orphans` is deliberately NOT enabled. It fired on nine modules that
    // are all genuinely imported (urlSafety, localAccess, basicAuth, colors,
    // layout, editorLang, anthropicKeyCheck, GithubMark, postcss.config) —
    // false positives caused by unresolved path aliases, plus config files that
    // are legitimately never imported. A warn-level rule that cries wolf nine
    // times teaches everyone to ignore the tool, which costs more than the
    // dead code it would find. Unreferenced-export detection is knip's job
    // (LLD §13.1 already uses it to find dead shims).
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "\\.next/",
        "/tests?/",
        "\\.test\\.ts$",
        "/node_modules/",
        "^apps/web/terminal/",
        // Runtime state, not source: apps/web/data/workspaces/ holds full git
        // clones of analysed repositories, so cruising it reports violations
        // against other projects' code. Gitignored, so CI never saw it and
        // only a developer who had used the app would hit the failure.
        "^apps/web/data/",
      ],
    },
    tsPreCompilationDeps: true,
    // tsconfig.depcruise.json, not tsconfig.base.json: the cruiser needs
    // apps/web's `@/*` alias to resolve, and that file explains why it cannot
    // simply read apps/web/tsconfig.json. Load-bearing — with the alias
    // unresolved the cruiser saw only a fraction of the import graph, so every
    // layering rule below passed by never seeing the edges. A gate that
    // under-reports is worse than no gate.
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    enhancedResolveOptions: {
      // These two are what let a workspace package be followed through
      // `"exports": { ".": "./src/index.ts" }` (LLD §1.1) rather than being
      // reported unresolvable.
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
