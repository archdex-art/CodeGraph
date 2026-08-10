import type { Dirent } from "node:fs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Known-vulnerability lookup against OSV.dev.
 *
 * WHAT THIS CANNOT SEE, stated up front because the report shape is designed around it:
 *
 *  - It reads MANIFESTS AND ONE LOCKFILE, not `node_modules`. A dependency installed but not
 *    recorded, or recorded but not installed, is invisible. The lockfile is the install
 *    contract; the disk is the truth, and we do not read the disk.
 *  - `/v1/querybatch` answers with ABBREVIATED vulnerability objects — in production, `id` and
 *    `modified` and nothing else. Severity, fix version and references live behind
 *    `/v1/vulns/{id}`, which the injected transport shape cannot issue. So against the live
 *    API most advisories arrive as `severity: "unknown"` and `fixedIn: null`. Those are not
 *    placeholders for "safe" or "no fix" — they mean the batch endpoint did not say. The
 *    mapper reads the full fields whenever they ARE present, so a richer transport (a cached
 *    OSV dump, a proxy that hydrates) upgrades the output with no change here.
 *  - A manifest range is not an installed version. Matching `^4.17.0` against a vulnerability
 *    database answers a question nobody asked; every advisory derived that way is flagged
 *    `approximateMatch` and must be rendered as such.
 *
 * The whole point of the module is that "we could not check" is unrepresentable as "clean":
 * `AdvisoryReport.status` discriminates, and an empty `advisories` array is only meaningful
 * when `status === "checked"`.
 */

export interface Advisory {
  readonly id: string;
  readonly package: string;
  readonly installedVersion: string | null;
  readonly severity: "critical" | "high" | "medium" | "low" | "unknown";
  readonly summary: string;
  readonly fixedIn: string | null;
  readonly url: string | null;
  readonly direct: boolean;
  /** True when matched against a manifest RANGE rather than a locked version. */
  readonly approximateMatch: boolean;
}

export interface AdvisoryReport {
  readonly status: "checked" | "unavailable" | "disabled";
  /**
   * Why the check did not happen — and, on a `checked` report, why it was PARTIAL. A non-null
   * `reason` alongside `status: "checked"` means the advisory list is real but incomplete
   * (packages capped, or versions that could not be resolved and so were never queried).
   * Rendering must not drop it.
   */
  readonly reason: string | null;
  readonly advisories: readonly Advisory[];
  /**
   * How many packages were actually sent to OSV. Lower than the input length whenever the cap
   * bit or a package had no resolvable version; that difference is the honest measure of the
   * gap between what was scanned and what was checked.
   */
  readonly packagesQueried: number;
  /** Non-null only when a check completed. `unavailable` and `disabled` never carry a time. */
  readonly checkedAt: number | null;
}

export interface ResolvedPackage {
  readonly name: string;
  readonly version: string | null;
  readonly ecosystem: "npm" | "PyPI" | "Go" | "crates.io";
  readonly direct: boolean;
  readonly approximate: boolean;
}

/**
 * ONLY `npm` IS RESOLVED. The union names the other three because they are OSV's identifiers
 * and the transport is ecosystem-agnostic, but `resolvePackages` never emits them: a
 * `requirements.txt` inequality or a `Cargo.lock` we half-parse would produce a *guessed*
 * version, and a guessed version queried against a vulnerability database returns confident
 * nonsense in both directions. A gap we can see beats a finding we invented.
 */
const NPM: ResolvedPackage["ecosystem"] = "npm";

/** The host is a module constant. Repository-controlled data (package names, versions,
 *  advisory ids) only ever travels inside the JSON request body — never in the URL, never in
 *  a path segment, never in a query string. A manifest cannot redirect this request. */
const OSV_QUERYBATCH_URL = "https://api.osv.dev/v1/querybatch";
/** Display link only; never fetched. Built from this constant plus a percent-encoded id. */
const OSV_VULN_PAGE = "https://osv.dev/vulnerability/";

// Every bound below exists because the input is an attacker-authored repository.
/** Directory depth of the manifest walk. Deeper trees are real but their manifests are noise. */
const MAX_WALK_DEPTH = 8;
/** Manifests parsed. A repo can contain thousands of `package.json` files as fixtures. */
const MAX_MANIFESTS = 128;
/** Refuse to parse a lockfile larger than this rather than pull it into memory. */
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
/** Nesting of the v1 lockfile `dependencies` tree, which is attacker-shaped recursion. */
const MAX_LOCK_DEPTH = 32;
/** Packages `resolvePackages` will return. Directs are kept in preference to transitives. */
const MAX_RESOLVED_PACKAGES = 2_000;
/** Packages sent to OSV per report, unless the caller lowers it. */
const DEFAULT_MAX_QUERY_PACKAGES = 500;
/** Queries per HTTP request; keeps a single request body and response bounded. */
const MAX_BATCH_QUERIES = 100;
/** Response characters accepted per request before the batch is declared unusable. */
const MAX_RESPONSE_CHARS = 4_000_000;
/** Response bytes the real transport will read before aborting the connection. */
const MAX_RESPONSE_BYTES = 4_000_000;
/** Advisories in one report. Beyond this the list is not a work queue any more. */
const MAX_ADVISORIES = 500;
/** Characters of `details` used when a vulnerability carries no `summary`. */
const MAX_SUMMARY_CHARS = 300;
/** Default request timeout. OSV is a dependency of a scan, not of correctness. */
const OSV_TIMEOUT_MS = 10_000;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "vendor",
  "target",
]);

const SEVERITY_RANK: Record<Advisory["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Manifest discovery, bounded and symlink-proof.
 *
 * `withFileTypes` reports a symlink as a symlink, not a directory, so we never follow one —
 * a repository containing `link -> /` would otherwise walk the host filesystem. `node_modules`
 * is skipped for the same reason `analyzeDependencies` skips it: an installed tree's manifests
 * describe somebody else's package, and a nested clone's manifests describe another project.
 */
function findManifests(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_MANIFESTS) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory is a gap, not a crash.
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) subdirs.push(entry.name);
      } else if (entry.isFile() && entry.name === "package.json") {
        if (found.length < MAX_MANIFESTS) found.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
    subdirs.sort(); // Filesystem order is not stable across machines; the cap must bite deterministically.
    for (const sub of subdirs) walk(path.join(dir, sub), depth + 1);
  };
  walk(root, 0);
  found.sort();
  return found;
}

interface Declared {
  /** Manifest range, kept for the fallback when the lockfile has nothing. */
  readonly range: string;
}

function readManifests(root: string, manifests: readonly string[]): {
  declared: Map<string, Declared>;
  internal: Set<string>;
} {
  const declared = new Map<string, Declared>();
  const internal = new Set<string>();
  const pending: Array<Record<string, string>> = [];

  for (const rel of manifests) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    } catch {
      continue; // `analyzeDependencies` already reports the unparseable manifest as a finding.
    }
    if (!isRecord(parsed)) continue;
    const name = asString(parsed["name"]);
    if (name !== null) internal.add(name);
    const deps: Record<string, string> = {};
    for (const field of ["dependencies", "devDependencies"] as const) {
      const block = parsed[field];
      if (!isRecord(block)) continue;
      for (const [dep, range] of Object.entries(block)) {
        const asRange = asString(range);
        if (asRange !== null) deps[dep] = asRange;
      }
    }
    pending.push(deps);
  }

  // Second pass, exactly as `analyzeDependencies` does it: a workspace sibling is internal
  // whichever order the manifests were read in.
  for (const deps of pending) {
    for (const [name, range] of Object.entries(deps)) {
      if (internal.has(name)) continue;
      if (!declared.has(name)) declared.set(name, { range });
    }
  }
  return { declared, internal };
}

/**
 * Locked versions from the root `package-lock.json`.
 *
 * Root only, for the reason the lockfile hygiene check gives: one root lockfile covers every
 * workspace member, and a per-member lockfile is not a thing npm workspaces produces.
 *
 * A name maps to a SET of versions because a lockfile legitimately pins several copies of the
 * same package at different versions. Collapsing them to one would silently un-check a
 * vulnerable transitive copy that a healthy top-level copy shadows.
 */
function readLockedVersions(root: string): Map<string, Set<string>> {
  const locked = new Map<string, Set<string>>();
  const lockPath = path.join(root, "package-lock.json");
  if (!existsSync(lockPath)) return locked;
  try {
    if (statSync(lockPath).size > MAX_LOCKFILE_BYTES) return locked;
  } catch {
    return locked;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return locked;
  }
  if (!isRecord(parsed)) return locked;

  const record = (name: string | null, version: string | null): void => {
    if (name === null || version === null) return;
    const versions = locked.get(name);
    if (versions === undefined) locked.set(name, new Set([version]));
    else versions.add(version);
  };

  // lockfileVersion 2/3: a flat `packages` map keyed by install path.
  const packages = parsed["packages"];
  if (isRecord(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (!isRecord(entry)) continue;
      // `link: true` entries point at a workspace directory; the real entry lives elsewhere.
      if (entry["link"] === true) continue;
      const marker = key.lastIndexOf("node_modules/");
      if (marker === -1) continue; // "" is the root project, "packages/x" is a workspace member.
      const name = key.slice(marker + "node_modules/".length);
      record(asString(name), asString(entry["version"]));
    }
  }

  // lockfileVersion 1: a recursive `dependencies` tree.
  const walkV1 = (block: unknown, depth: number): void => {
    if (depth > MAX_LOCK_DEPTH || !isRecord(block)) return;
    for (const [name, entry] of Object.entries(block)) {
      if (!isRecord(entry)) continue;
      record(asString(name), asString(entry["version"]));
      walkV1(entry["dependencies"], depth + 1);
    }
  };
  walkV1(parsed["dependencies"], 0);

  return locked;
}

/**
 * The exact version a range would MOST LIKELY install is unknowable without resolving against
 * the registry, which we will not do. What is knowable is the version literally written in the
 * range, so `^4.17.20` yields `4.17.20` — the floor of the range, not the installed version.
 * Anything without a concrete floor (`*`, `latest`, a git or file URL, a tag) yields null and
 * is never queried, because OSV answering "every vulnerability this package ever had" would
 * read exactly like a set of live findings.
 */
function rangeFloor(range: string): string | null {
  const match = /^[\s~^]*(?:[<>]=?|=)?\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(range);
  return match?.[1] ?? null;
}

/** Numeric-segment comparison. Not full semver: prerelease ordering is ignored, which only
 *  affects which of two fixes is offered, never whether one is reported. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[-+]/, 1)[0]?.split(".") ?? [];
  const partsB = b.split(/[-+]/, 1)[0]?.split(".") ?? [];
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const numA = Number.parseInt(partsA[i] ?? "0", 10);
    const numB = Number.parseInt(partsB[i] ?? "0", 10);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      const textA = partsA[i] ?? "";
      const textB = partsB[i] ?? "";
      if (textA !== textB) return textA < textB ? -1 : 1;
      continue;
    }
    if (numA !== numB) return numA < numB ? -1 : 1;
  }
  return 0;
}

/** Pure: parse manifests + lockfile into the set to query. */
export function resolvePackages(root: string): ResolvedPackage[] {
  const manifests = findManifests(root);
  const { declared, internal } = readManifests(root, manifests);
  const locked = readLockedVersions(root);

  const direct: ResolvedPackage[] = [];
  const transitive: ResolvedPackage[] = [];

  for (const [name, entry] of declared) {
    const versions = locked.get(name);
    if (versions !== undefined && versions.size > 0) {
      for (const version of versions) {
        direct.push({ name, version, ecosystem: NPM, direct: true, approximate: false });
      }
    } else {
      // No lockfile entry: the range floor is the best available, and it is a guess.
      direct.push({
        name,
        version: rangeFloor(entry.range),
        ecosystem: NPM,
        direct: true,
        approximate: true,
      });
    }
  }

  for (const [name, versions] of locked) {
    if (declared.has(name) || internal.has(name)) continue;
    for (const version of versions) {
      transitive.push({ name, version, ecosystem: NPM, direct: false, approximate: false });
    }
  }

  const byNameThenVersion = (a: ResolvedPackage, b: ResolvedPackage): number => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const versionA = a.version ?? "";
    const versionB = b.version ?? "";
    if (versionA === versionB) return 0;
    return versionA < versionB ? -1 : 1;
  };
  direct.sort(byNameThenVersion);
  transitive.sort(byNameThenVersion);

  // When the cap bites, a declared dependency is worth more than a transitive one: it is the
  // one the maintainer can actually change. Truncation is deterministic in both lists.
  const kept = direct.slice(0, MAX_RESOLVED_PACKAGES);
  if (kept.length < MAX_RESOLVED_PACKAGES) {
    kept.push(...transitive.slice(0, MAX_RESOLVED_PACKAGES - kept.length));
  }
  kept.sort(byNameThenVersion);
  return kept;
}

/** Transport is INJECTED so tests never touch the network. */
export type OsvTransport = (body: string) => Promise<string>;

function unavailable(reason: string, packagesQueried: number): AdvisoryReport {
  return { status: "unavailable", reason, advisories: [], packagesQueried, checkedAt: null };
}

export function disabledReport(reason: string): AdvisoryReport {
  return { status: "disabled", reason, advisories: [], packagesQueried: 0, checkedAt: null };
}

function mapSeverity(raw: string | null): Advisory["severity"] {
  switch (raw?.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      // Includes the common case of a CVSS vector with no band. We do not compute a base score
      // from an unparsed vector: a wrong band is worse than an admitted absence.
      return "unknown";
  }
}

function severityOf(vuln: Record<string, unknown>, affected: readonly unknown[]): Advisory["severity"] {
  const top = vuln["database_specific"];
  if (isRecord(top)) {
    const mapped = mapSeverity(asString(top["severity"]));
    if (mapped !== "unknown") return mapped;
  }
  for (const entry of affected) {
    if (!isRecord(entry)) continue;
    const specific = entry["database_specific"];
    if (!isRecord(specific)) continue;
    const mapped = mapSeverity(asString(specific["severity"]));
    if (mapped !== "unknown") return mapped;
  }
  return "unknown";
}

/**
 * The lowest published fix that is actually ahead of what is installed. A vulnerability fixed
 * in both `1.2.4` and `2.0.1` must not tell a `2.0.0` user to downgrade to `1.2.4`; when the
 * installed version is unknown or approximate, the lowest fix is offered without that filter.
 */
function fixedInFor(affected: readonly unknown[], pkgName: string, installed: string | null): string | null {
  const fixes: string[] = [];
  for (const entry of affected) {
    if (!isRecord(entry)) continue;
    const pkg = entry["package"];
    if (isRecord(pkg)) {
      const name = asString(pkg["name"]);
      if (name !== null && name !== pkgName) continue;
    }
    const ranges = entry["ranges"];
    if (!Array.isArray(ranges)) continue;
    for (const range of ranges) {
      if (!isRecord(range)) continue;
      const events = range["events"];
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        if (!isRecord(event)) continue;
        const fixed = asString(event["fixed"]);
        if (fixed !== null) fixes.push(fixed);
      }
    }
  }
  if (fixes.length === 0) return null;
  fixes.sort(compareVersions);
  if (installed !== null) {
    for (const fix of fixes) {
      if (compareVersions(fix, installed) > 0) return fix;
    }
  }
  return fixes[0] ?? null;
}

function urlFor(vuln: Record<string, unknown>, id: string): string {
  const references = vuln["references"];
  if (Array.isArray(references)) {
    let firstUrl: string | null = null;
    for (const reference of references) {
      if (!isRecord(reference)) continue;
      const url = asString(reference["url"]);
      if (url === null) continue;
      if (asString(reference["type"])?.toUpperCase() === "ADVISORY") return url;
      firstUrl ??= url;
    }
    if (firstUrl !== null) return firstUrl;
  }
  return OSV_VULN_PAGE + encodeURIComponent(id);
}

function summaryFor(vuln: Record<string, unknown>, id: string): string {
  const summary = asString(vuln["summary"]);
  if (summary !== null) return summary.slice(0, MAX_SUMMARY_CHARS);
  const details = asString(vuln["details"]);
  if (details !== null) {
    const firstLine = details.split("\n")[0]?.trim() ?? "";
    if (firstLine !== "") return firstLine.slice(0, MAX_SUMMARY_CHARS);
  }
  // Says what happened rather than inventing prose: the batch endpoint omits both fields.
  return `${id} — OSV returned no summary for this advisory`;
}

function toAdvisory(vuln: unknown, pkg: ResolvedPackage): Advisory | null {
  if (!isRecord(vuln)) return null;
  const id = asString(vuln["id"]);
  if (id === null) return null; // An advisory we cannot name is an advisory we cannot act on.
  const affectedRaw = vuln["affected"];
  const affected: readonly unknown[] = Array.isArray(affectedRaw) ? affectedRaw : [];
  return {
    id,
    package: pkg.name,
    installedVersion: pkg.version,
    severity: severityOf(vuln, affected),
    summary: summaryFor(vuln, id),
    fixedIn: fixedInFor(affected, pkg.name, pkg.approximate ? null : pkg.version),
    url: urlFor(vuln, id),
    direct: pkg.direct,
    approximateMatch: pkg.approximate,
  };
}

/**
 * `results[i]` answers `queries[i]` — index alignment is the ONLY link between a vulnerability
 * and the package it belongs to. A length mismatch therefore means every attribution in the
 * batch is suspect, so the whole report goes `unavailable` rather than mislabel one advisory.
 */
function parseBatch(raw: string, chunk: readonly ResolvedPackage[]): Advisory[] | string {
  if (raw.length > MAX_RESPONSE_CHARS) {
    return `OSV response exceeded ${MAX_RESPONSE_CHARS} characters`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "OSV response was not JSON";
  }
  if (!isRecord(parsed)) return "OSV response was not a JSON object";

  // gRPC-gateway error shape: `{ code, message }`. It parses fine and has no `results`, which
  // is precisely the shape that would otherwise read as "checked, nothing found".
  const results = parsed["results"];
  if (!Array.isArray(results)) {
    const message = asString(parsed["message"]) ?? asString(parsed["error"]);
    return message === null ? "OSV response had no `results` array" : `OSV error: ${message}`;
  }
  if (results.length !== chunk.length) {
    return `OSV returned ${results.length} results for ${chunk.length} queries`;
  }

  const advisories: Advisory[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const pkg = chunk[i];
    if (pkg === undefined) continue;
    const entry = results[i];
    if (!isRecord(entry)) continue;
    const vulns = entry["vulns"];
    if (!Array.isArray(vulns)) continue; // OSV omits `vulns` entirely for a clean package.
    for (const vuln of vulns) {
      const advisory = toAdvisory(vuln, pkg);
      if (advisory !== null) advisories.push(advisory);
    }
  }
  return advisories;
}

export async function fetchAdvisories(
  pkgs: readonly ResolvedPackage[],
  transport: OsvTransport,
  opts?: { maxPackages?: number },
): Promise<AdvisoryReport> {
  const cap = Math.max(0, Math.trunc(opts?.maxPackages ?? DEFAULT_MAX_QUERY_PACKAGES));

  // Only packages with a concrete version are queried; see `rangeFloor`. The count of the rest
  // becomes part of `reason`, so a partial check can never present itself as a whole one.
  const queryable = pkgs.filter((pkg) => pkg.version !== null);
  const unresolved = pkgs.length - queryable.length;
  const chunkAll = queryable.slice(0, cap);
  const overCap = queryable.length - chunkAll.length;

  const caveats: string[] = [];
  if (overCap > 0) caveats.push(`${overCap} of ${queryable.length} packages skipped by the ${cap}-package cap`);
  if (unresolved > 0) caveats.push(`${unresolved} packages had no resolvable version and were not queried`);
  const reason = caveats.length === 0 ? null : caveats.join("; ");

  const advisories: Advisory[] = [];
  for (let offset = 0; offset < chunkAll.length; offset += MAX_BATCH_QUERIES) {
    const chunk = chunkAll.slice(offset, offset + MAX_BATCH_QUERIES);
    const body = JSON.stringify({
      queries: chunk.map((pkg) => ({
        package: { name: pkg.name, ecosystem: pkg.ecosystem },
        version: pkg.version,
      })),
    });

    let raw: string;
    try {
      raw = await transport(body);
    } catch (err) {
      // A timeout, a DNS failure and a 503 all land here, and all of them mean the same thing:
      // we do not know. Partial results from earlier chunks are DISCARDED — half a list
      // presented as a list is the failure mode this module exists to prevent.
      const detail = err instanceof Error ? err.message : String(err);
      return unavailable(`OSV request failed: ${detail}`, 0);
    }

    const parsed = parseBatch(raw, chunk);
    if (typeof parsed === "string") return unavailable(parsed, 0);
    advisories.push(...parsed);
  }

  // Deterministic order: worst first, then a stable alphabetical tiebreak. Nothing here may
  // depend on Map or Set iteration order or on the order the filesystem handed us manifests.
  const seen = new Set<string>();
  const unique: Advisory[] = [];
  for (const advisory of advisories) {
    const key = `${advisory.package}\u0000${advisory.installedVersion ?? ""}\u0000${advisory.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(advisory);
  }
  unique.sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (a.package !== b.package) return a.package < b.package ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });

  const truncated = unique.length > MAX_ADVISORIES;
  const finalReason = truncated
    ? [reason, `advisory list truncated to ${MAX_ADVISORIES} of ${unique.length}`]
        .filter((part): part is string => part !== null)
        .join("; ")
    : reason;

  return {
    status: "checked",
    reason: finalReason,
    advisories: truncated ? unique.slice(0, MAX_ADVISORIES) : unique,
    packagesQueried: chunkAll.length,
    checkedAt: Date.now(),
  };
}

/**
 * Reads the body under a hard byte cap instead of `res.text()`, which would happily buffer a
 * response as large as the peer cares to send. The connection is cancelled the moment the cap
 * is passed.
 */
async function readCapped(res: Response): Promise<string> {
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`OSV response declared ${declared} bytes, over the ${MAX_RESPONSE_BYTES} cap`);
  }
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`OSV response exceeded the ${MAX_RESPONSE_BYTES} byte cap`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The real transport. Host is a CONSTANT; a package name only ever travels in the JSON body. */
export function osvTransport(timeoutMs = OSV_TIMEOUT_MS): OsvTransport {
  return async (body: string): Promise<string> => {
    const res = await fetch(OSV_QUERYBATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      // No API key, and none is required — that is why OSV was chosen over the alternatives.
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) {
      // Throwing here is what turns a 429 or a 503 into `status: "unavailable"` upstream.
      throw new Error(`OSV responded ${res.status} ${res.statusText}`);
    }
    return await readCapped(res);
  };
}
