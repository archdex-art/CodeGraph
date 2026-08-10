import { ruleIdOf } from "./findings";
import { DIMENSION_META, type Dimension } from "./models";
import type { Issue } from "./models";

/**
 * SARIF 2.1.0 export adapter (ADR-006, HLD §3 interoperability).
 *
 * **One direction only.** `Issue` stays the internal model and nothing here flows back inward:
 * no SARIF type appears in a signature the rest of the codebase uses, and this module imports
 * from the model rather than the model importing from it. IDENTITY.md §4.3 - interchange
 * formats are exports, never the internal model - is the reason, and the layering makes it
 * mechanical rather than a matter of discipline.
 *
 * Implemented from the specification's shape rather than by adopting a SARIF library, so the
 * dependency footprint stays at zero and the mapping decisions below are visible instead of
 * buried in someone else's defaults.
 */

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: { name: string; informationUri: string; rules: SarifRule[] } };
  results: SarifResult[];
  invocations: Array<{ executionSuccessful: boolean; endTimeUtc?: string }>;
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { dimension: Dimension; tags: string[] };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number };
    };
  }>;
  properties: Record<string, unknown>;
  /**
   * SARIF's own word for "reported, and accepted anyway". Present only on accepted findings:
   * an empty array means "not suppressed" to some consumers and "suppressed by nothing" to
   * others, and the spec's own advice is to omit it.
   */
  suppressions?: Array<{ kind: "external" }>;
}

type SarifLevel = "error" | "warning" | "note";

/**
 * Severity 1-5 collapses to SARIF's three levels, and the boundary is a judgement worth
 * stating: 4-5 are things that can be exploited or break at runtime, 3 is a real defect that
 * is not urgent, 1-2 are hygiene. A consumer who wants the original number reads
 * `properties.severity`, which is emitted unchanged.
 */
function levelFor(severity: number): SarifLevel {
  if (severity >= 4) return "error";
  if (severity === 3) return "warning";
  return "note";
}

/**
 * A stable rule id derived from the title, for findings persisted before `Issue.rule` existed.
 *
 * Kept as a FALLBACK rather than deleted: this slug is the id already published to every
 * consumer that has ingested a CodeGraph log, and `ruleIdOf`'s own fallback slugs differently
 * (it strips digits and bracketed spans). Re-slugging old rows would make GitHub code scanning
 * close every existing alert and open an identical one under a new id.
 */
export function sarifRuleId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `codegraph/${slug || "finding"}`;
}

export interface SarifOptions {
  /** Repository-relative paths are already what `Issue.file` holds; this is informational. */
  informationUri?: string;
  endTimeUtc?: string;
}

/**
 * Convert findings to a SARIF 2.1.0 log.
 *
 * **Deliberately absent: `rank`.** SARIF offers a 0-100 priority field, and filling it would
 * mean exporting a second ranking that can disagree with the Health Score. The inputs
 * (`severity`, `confidence`, `blastRadius`, `churn`) are all emitted in `properties`, so a
 * consumer can order results however it likes without CodeGraph publishing a number it does
 * not use itself.
 *
 * **Deliberately absent: `partialFingerprints`.** `Issue` carries no fingerprint;
 * `@codegraph/core-domain` has a real one keyed on a normalised snippet, which is not available
 * here. Emitting a weaker hash under the same name would silently disagree with the product's
 * own identity for a finding, so the field is omitted until findings carry the real one.
 */
export function toSarif(issues: readonly Issue[], opts: SarifOptions = {}): SarifLog {
  const rules = new Map<string, SarifRule>();
  const results: SarifResult[] = [];

  for (const issue of issues) {
    // The declared rule id when the finding has one, the legacy title slug when it does not.
    // `ruleIdOf`'s own fallback is NOT used here — see `sarifRuleId`.
    const ruleId = issue.rule ? ruleIdOf(issue) : sarifRuleId(issue.title);
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: issue.title,
        shortDescription: { text: issue.title },
        defaultConfiguration: { level: levelFor(issue.severity) },
        properties: {
          dimension: issue.dimension,
          tags: [issue.dimension, DIMENSION_META[issue.dimension]?.label ?? issue.dimension],
        },
      });
    }
    results.push({
      ruleId,
      level: levelFor(issue.severity),
      message: { text: issue.title },
      locations: [
        {
          physicalLocation: {
            // SARIF requires a URI reference; repo-relative POSIX paths are valid and keep the
            // log portable across machines, which absolute paths would not.
            artifactLocation: { uri: issue.file.split("\\").join("/") },
            region: { startLine: Math.max(1, issue.line) },
          },
        },
      ],
      properties: {
        severity: issue.severity,
        dimension: issue.dimension,
        blastRadius: issue.blastRadius,
        ...(issue.confidence === undefined ? {} : { confidence: issue.confidence }),
        ...(issue.churn === undefined ? {} : { churn: issue.churn }),
        ...(issue.occurrences === undefined ? {} : { occurrences: issue.occurrences }),
        // The one line that lets a reviewer falsify the finding without opening the file. In
        // `properties` rather than folded into `message.text`, so a consumer can show the
        // claim and the evidence separately — GitHub renders the message as the alert title.
        ...(issue.evidence === undefined ? {} : { evidence: issue.evidence }),
      },
      // `kind: "external"` — the acceptance lives outside the log, in `.codegraph-baseline.json`
      // or an inline `codegraph-ignore`. Emitting the result and marking it beats dropping it:
      // GitHub code scanning then shows the alert as dismissed, so a baseline stays auditable
      // instead of becoming an invisible allowlist.
      ...(issue.suppressed ? { suppressions: [{ kind: "external" as const }] } : {}),
    });
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "CodeGraph",
            informationUri: opts.informationUri ?? "https://github.com/archdex-art/CodeGraph",
            rules: [...rules.values()],
          },
        },
        results,
        invocations: [
          { executionSuccessful: true, ...(opts.endTimeUtc ? { endTimeUtc: opts.endTimeUtc } : {}) },
        ],
      },
    ],
  };
}
