import type { QueryEngine, SymbolGraph } from "@codegraph/core-graph";

/**
 * Dependency intelligence: which declared packages nothing uses, and what breaks if you
 * replace one.
 *
 * **What this cannot see.** Neither question is decidable from source text. A package can be
 * loaded by a config file this never reads, by a plugin resolver that turns a short name into
 * a package name, by `require(variable)`, by a `postinstall` script, or by a bundler alias.
 * So "unused" here is a CANDIDATE carrying a stated confidence and a stated reason it might be
 * wrong — never a verdict. The failure this exists to prevent is the one an unqualified
 * "unused dependency" list causes: somebody deletes `@types/node` or `eslint-plugin-security`
 * because a tool said nothing imported it, and the build breaks in CI instead of in review.
 *
 * `confidence` is DERIVED from which false-positive class applied, and every class that
 * applies also writes a `caveat`. A candidate with no caveat is one where every class we know
 * how to check came back clean — still not proof, which is why the base sits below 1.0.
 */

/** Scopes we can reason about. `bundleDependencies` and friends are skipped, not guessed at. */
export type DependencyScope =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

export interface UnusedDependency {
  readonly name: string;
  /** Manifest path the declaration came from, repo-relative. */
  readonly declaredIn: string;
  readonly scope: DependencyScope;
  /** 0..1, derived from the downgrades below. Never 1.0 — see `CONFIDENCE_BASE`. */
  readonly confidence: number;
  /** Why this might be a false positive, and when. `null` only when nothing downgraded it. */
  readonly caveat: string | null;
}

export interface PackageImportSite {
  readonly file: string;
  readonly line: number;
  /** Enclosing symbol, or `null` when the import sits outside every extracted symbol. */
  readonly symbolId: string | null;
}

export interface ReplacementImpact {
  readonly package: string;
  readonly importSites: readonly PackageImportSite[];
  /** Symbols defined in the files that import the package. */
  readonly directSymbols: readonly string[];
  /** Transitive callers of `directSymbols`, excluding the direct symbols themselves. */
  readonly blastRadius: readonly string[];
  /** A cap was hit, or the symbol graph itself was truncated — the answer is a lower bound. */
  readonly truncated: boolean;
}

/**
 * A clean candidate still tops out below 1.0. `require()` on a computed name, bundler aliases
 * and config-driven loaders are all invisible here, so certainty is not on offer.
 */
const CONFIDENCE_BASE = 0.9;

/**
 * Deductions are additive and named, so a reported confidence can be read back to the classes
 * that produced it rather than being an opaque number.
 */
const DEDUCTION = {
  /** DefinitelyTyped packages are consumed by the compiler's `types` resolution, never imported. */
  typesPackage: 0.75,
  /** Dev deps are routinely driven by tooling config, editor integrations and CI we never read. */
  devScope: 0.25,
  /** An optional dep is expected to be absent at runtime; nothing importing it proves little. */
  optionalScope: 0.4,
  /** Named like a plugin, but no config file of that ecosystem is present to confirm it. */
  pluginNaming: 0.35,
} as const;

const CAVEAT = {
  typesPackage:
    "`@types/*` packages are pulled in by the TypeScript compiler, not by an import — an unreferenced one is only genuinely unused if nothing in the repo uses the runtime package it types",
  devScope:
    "devDependency: build tooling, editor integrations and CI steps load packages in ways this never reads",
  optionalScope:
    "optionalDependency: designed to be absent at runtime, so guarded/dynamic loading is the normal usage pattern",
  pluginNaming:
    "named like a plugin/preset, which are loaded by string from an ecosystem config file rather than imported — no matching config file was found, but one may live outside the scanned set",
} as const;

/** Attacker-authored manifests: a single package.json can declare tens of thousands of deps. */
const MAX_DECLARED = 5_000;
const MAX_REPORTED = 500;
/** Scripts are shell text; a pathological one is megabytes on a single line. */
const MAX_SCRIPTS_SCANNED = 500;
const MAX_SCRIPT_CHARS = 4_000;

/** Bounds for `replacementImpact`. */
const MAX_FILES_SCANNED = 20_000;
/** Minified bundles are one line of hundreds of KB: scanning them finds nothing and costs a lot. */
const MAX_LINE_CHARS = 2_000;
const MAX_IMPORT_SITES = 500;
const MAX_DIRECT_SYMBOLS = 2_000;
const MAX_BLAST_RADIUS = 2_000;
/** Same depth `QueryEngine.impact` defaults to; past 3 hops "what breaks" is the whole repo. */
const IMPACT_DEPTH = 3;

/** Static table, so a scope string narrows to `DependencyScope` by lookup rather than by cast. */
const KNOWN_SCOPES = new Map<string, DependencyScope | undefined>(Object.entries({
  dependencies: "dependencies",
  devDependencies: "devDependencies",
  peerDependencies: "peerDependencies",
  optionalDependencies: "optionalDependencies",
}));

/**
 * Plugin ecosystems: a name pattern plus the config files that would load such a plugin by
 * string. Both halves are required to EXCLUDE a candidate — the naming convention alone only
 * downgrades it, because `eslint-plugin-foo` in a repo with no ESLint config really is dead
 * weight and saying so is the whole point.
 */
interface PluginEcosystem {
  readonly names: readonly RegExp[];
  readonly configs: readonly RegExp[];
}

const PLUGIN_ECOSYSTEMS = new Map<string, PluginEcosystem>(Object.entries({
  eslint: {
    names: [/^eslint-(plugin|config)-/, /^@[^/]+\/eslint-(plugin|config)(-|$)/],
    configs: [/^\.eslintrc(\.|$)/, /^eslint\.config\.[cm]?[jt]s$/],
  },
  babel: {
    names: [/^babel-(plugin|preset)-/, /^@[^/]+\/(babel-)?(plugin|preset)-/],
    configs: [/^\.babelrc(\.|$)/, /^babel\.config\.[cm]?[jt]s(on)?$/],
  },
  postcss: {
    names: [/^postcss-/, /^@[^/]+\/postcss-/],
    configs: [/^postcss\.config\.[cm]?[jt]s$/, /^\.postcssrc(\.|$)/],
  },
  tailwind: {
    names: [/^tailwindcss-/, /^@tailwindcss\//],
    configs: [/^tailwind\.config\.[cm]?[jt]s$/],
  },
  prettier: {
    names: [/^prettier-plugin-/, /^@[^/]+\/prettier-(plugin|config)(-|$)/],
    configs: [/^\.prettierrc(\.|$)/, /^prettier\.config\.[cm]?[jt]s$/],
  },
  stylelint: {
    names: [/^stylelint-(plugin|config)-/, /^@[^/]+\/stylelint-(plugin|config)(-|$)/],
    configs: [/^\.stylelintrc(\.|$)/, /^stylelint\.config\.[cm]?[jt]s$/],
  },
}));

/**
 * The package a specifier belongs to, or `null` when it names no package at all.
 *
 * THE SUBPATH BUG THIS FIXES. Comparing a declared name against raw specifiers reports
 * `lodash` as unused in a file whose only line is `import get from "lodash/get"`, and
 * `@scope/pkg` as unused next to `@scope/pkg/client`. Deleting on that advice breaks the
 * build. Node builtins collapse to `node` so that `@types/node` can be recognised as used by
 * a repo whose only "import" of Node is `node:fs`.
 */
function packageRoot(specifier: string): string | null {
  const spec = specifier.trim();
  if (spec === "" || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) {
    return null;
  }
  if (spec.startsWith("node:")) return "node";
  // A URL specifier (`https:`, `data:`, `file:`) resolves to no package name.
  if (/^[a-z][a-z0-9+.-]*:/.test(spec) && !spec.startsWith("@")) return null;
  const parts = spec.split("/");
  const head = parts[0] ?? "";
  if (spec.startsWith("@")) {
    const scoped = parts[1] ?? "";
    if (head === "@" || scoped === "") return null;
    return `${head}/${scoped}`;
  }
  return head === "" ? null : head;
}

/**
 * `@types/x` types `x`; DefinitelyTyped mangles a scoped name `@a/b` as `@types/a__b`.
 * Returns `null` for anything that is not a types package.
 */
function typedPackageOf(name: string): string | null {
  if (!name.startsWith("@types/")) return null;
  const tail = name.slice("@types/".length);
  if (tail === "") return null;
  const split = tail.indexOf("__");
  return split === -1 ? tail : `@${tail.slice(0, split)}/${tail.slice(split + 2)}`;
}

/** Tokens a shell command could be invoking, plus the package each token would resolve to. */
function scriptTokens(scripts: ReadonlyMap<string, string>): ReadonlySet<string> {
  const tokens = new Set<string>();
  let scanned = 0;
  for (const command of scripts.values()) {
    if (scanned++ >= MAX_SCRIPTS_SCANNED) break;
    const text = command.length > MAX_SCRIPT_CHARS ? command.slice(0, MAX_SCRIPT_CHARS) : command;
    // Whole tokens only. Substring matching would call `ts` used by a script running `tsc`,
    // and `react` used by one running `react-scripts` — both wrong in the dangerous direction.
    const re = /[@A-Za-z0-9_][@A-Za-z0-9_./-]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      tokens.add(m[0]);
      const root = packageRoot(m[0]);
      if (root !== null) tokens.add(root);
    }
  }
  return tokens;
}

/** The ecosystem whose naming convention `name` follows, or `null`. */
function pluginEcosystemOf(name: string): PluginEcosystem | null {
  for (const eco of PLUGIN_ECOSYSTEMS.values()) {
    for (const pattern of eco.names) {
      if (pattern.test(name)) return eco;
    }
  }
  return null;
}

/**
 * Declared dependencies that nothing appears to reference, each with the reason it might be
 * wrong. Deterministic: sorted by name, then manifest, then scope.
 *
 * `importedPackages` may hold raw specifiers (`lodash/get`, `node:fs`) or bare names; both are
 * normalised through `packageRoot` before comparison.
 */
export function findUnusedDependencies(input: {
  declared: ReadonlyArray<{ name: string; manifest: string; scope: string }>;
  importedPackages: ReadonlySet<string>;
  manifestScripts: ReadonlyMap<string, string>;
  configFiles: readonly string[];
}): UnusedDependency[] {
  const imported = new Set<string>();
  for (const specifier of input.importedPackages) {
    const root = packageRoot(specifier);
    if (root !== null) imported.add(root);
  }

  const tokens = scriptTokens(input.manifestScripts);
  const configs = input.configFiles.map((f) => f.slice(f.lastIndexOf("/") + 1));
  const results: UnusedDependency[] = [];

  let considered = 0;
  for (const dep of input.declared) {
    if (considered++ >= MAX_DECLARED) break;
    const { name } = dep;
    if (name === "") continue;
    // An unrecognised scope has semantics we do not know, and inventing them would be a
    // fabricated verdict on somebody's manifest.
    const scope = KNOWN_SCOPES.get(dep.scope);
    if (scope === undefined) continue;

    // EXCLUDED: peerDependencies are imported by the CONSUMER, not by this package. Every
    // peer dep of a library looks unreferenced from inside the library, so reporting them
    // means reporting the entire peer list of every library in the repo.
    if (scope === "peerDependencies") continue;

    // EXCLUDED: the package, or any subpath of it, is imported somewhere.
    if (imported.has(name)) continue;

    // EXCLUDED: a script invokes it. Test runners, bundlers, linters and CLIs are used by
    // name from `scripts`, never imported, and this is the single largest false-positive
    // class in a normal repo's devDependencies.
    if (tokens.has(name)) continue;

    const deductions: number[] = [];
    const caveats: string[] = [];

    const typed = typedPackageOf(name);
    if (typed !== null) {
      // EXCLUDED: the runtime package it types IS imported, so the types package is in use.
      if (imported.has(typed)) continue;
      deductions.push(DEDUCTION.typesPackage);
      caveats.push(CAVEAT.typesPackage);
    }

    const eco = pluginEcosystemOf(name);
    if (eco !== null) {
      // EXCLUDED: an ecosystem config file is present, so the plugin is very likely loaded by
      // string from it — `eslint-plugin-security` never appears in an `import` anywhere.
      const configured = configs.some((base) => eco.configs.some((re) => re.test(base)));
      if (configured) continue;
      deductions.push(DEDUCTION.pluginNaming);
      caveats.push(CAVEAT.pluginNaming);
    }

    if (scope === "devDependencies") {
      deductions.push(DEDUCTION.devScope);
      caveats.push(CAVEAT.devScope);
    } else if (scope === "optionalDependencies") {
      deductions.push(DEDUCTION.optionalScope);
      caveats.push(CAVEAT.optionalScope);
    }

    let confidence = CONFIDENCE_BASE;
    for (const d of deductions) confidence -= d;
    if (confidence < 0.05) confidence = 0.05;

    results.push({
      name,
      declaredIn: dep.manifest,
      scope,
      confidence: Math.round(confidence * 100) / 100,
      caveat: caveats.length === 0 ? null : caveats.join("; "),
    });
  }

  results.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.declaredIn.localeCompare(b.declaredIn) ||
      a.scope.localeCompare(b.scope),
  );
  return results.length > MAX_REPORTED ? results.slice(0, MAX_REPORTED) : results;
}

/**
 * Matches the specifier of an import/require on one line: `import "x"`, `import y from "x"`,
 * `export * from "x"`, `require("x")`, `import("x")`.
 *
 * Line-at-a-time on purpose. A multi-line `import {\n a,\n} from "pkg"` still has its
 * specifier on one line, and that is the line worth reporting — it is what a replacement edit
 * has to change.
 */
const SPECIFIER_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/**
 * What breaks if this library is swapped out: the import sites, the symbols living in those
 * files, and the transitive callers of those symbols.
 *
 * **What this cannot see.** The blast radius is only as good as the call graph, which resolves
 * calls heuristically by name — a caller reached through a callback, a dynamic dispatch or a
 * DI container is not in it. And a symbol in an importing file is counted as affected whether
 * or not it actually touches the library, because file-level import granularity is all the
 * graph has. The set is therefore neither a superset nor a subset of the truth; `truncated`
 * only tells you a cap was hit, not that the rest is complete.
 */
export function replacementImpact(
  pkg: string,
  files: ReadonlyArray<{ rel: string; text: string }>,
  graph: SymbolGraph,
  qe: QueryEngine,
): ReplacementImpact {
  const target = packageRoot(pkg);
  const importSites: PackageImportSite[] = [];
  const importingFiles = new Set<string>();
  let truncated = graph.truncated;

  if (files.length > MAX_FILES_SCANNED) truncated = true;
  const fileLimit = Math.min(files.length, MAX_FILES_SCANNED);

  scan: for (let i = 0; i < fileLimit; i++) {
    const file = files[i];
    if (file === undefined) continue;
    const lines = file.text.split("\n");
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (line === undefined || line.length > MAX_LINE_CHARS) continue;
      SPECIFIER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SPECIFIER_RE.exec(line)) !== null) {
        const specifier = m[1];
        if (specifier === undefined) continue;
        if (target === null || packageRoot(specifier) !== target) continue;
        if (importSites.length >= MAX_IMPORT_SITES) {
          truncated = true;
          break scan;
        }
        const enclosing = qe.symbolAt(file.rel, n + 1);
        importSites.push({
          file: file.rel,
          line: n + 1,
          symbolId: enclosing === undefined ? null : enclosing.id,
        });
        importingFiles.add(file.rel);
        break; // One site per line: a second specifier on the same line is the same edit.
      }
    }
  }

  const directSymbols: string[] = [];
  const direct = new Set<string>();
  for (const symbol of graph.symbols) {
    if (!importingFiles.has(symbol.file)) continue;
    if (directSymbols.length >= MAX_DIRECT_SYMBOLS) {
      truncated = true;
      break;
    }
    directSymbols.push(symbol.id);
    direct.add(symbol.id);
  }

  const blast = new Set<string>();
  for (const id of directSymbols) {
    for (const caller of qe.impact(id, IMPACT_DEPTH)) {
      // A direct symbol is already reported; listing it again as its own blast radius would
      // overstate the reach of the change.
      if (direct.has(caller.id)) continue;
      if (blast.size >= MAX_BLAST_RADIUS) {
        truncated = true;
        break;
      }
      blast.add(caller.id);
    }
    if (blast.size >= MAX_BLAST_RADIUS) break;
  }

  importSites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  directSymbols.sort((a, b) => a.localeCompare(b));
  const blastRadius = [...blast].sort((a, b) => a.localeCompare(b));

  return {
    package: pkg,
    importSites,
    directSymbols,
    blastRadius,
    truncated,
  };
}
