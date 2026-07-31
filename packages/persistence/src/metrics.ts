import { db } from "./db";

/**
 * Durable counters, and the Prometheus text rendering of them (HLD §14).
 *
 * Stored rather than held in memory because analysis runs in a per-job child process that
 * exits (ADR-001) while `/api/metrics` is served by the web tier — see migration 005 for the
 * full argument.
 */

export type MetricLabels = Readonly<Record<string, string>>;

/**
 * Canonical key for a metric plus its labels.
 *
 * Labels are sorted so `{gate,outcome}` and `{outcome,gate}` are the same series. Without that
 * the same logical counter splits into two rows depending on the order a caller happened to
 * write the object literal, and the totals silently halve.
 */
function keyFor(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  const rendered = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
  return `${name}{${rendered}}`;
}

/**
 * Prometheus label values are double-quoted, so a backslash, quote, or newline in one would
 * produce a malformed exposition line that breaks the whole scrape — not just that series.
 * Rule ids and gate reasons are the realistic source of those.
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Increment a counter. Creates the series on first use. */
export function incrementCounter(name: string, labels: MetricLabels = {}, by = 1): void {
  db()
    .prepare(
      `INSERT INTO metric_counters (key, name, labels_json, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`
    )
    .run(keyFor(name, labels), name, JSON.stringify(labels), by, Date.now());
}

export interface CounterRow {
  readonly key: string;
  readonly name: string;
  readonly labels_json: string;
  readonly value: number;
}

export function allCounters(): CounterRow[] {
  return db()
    .prepare("SELECT key, name, labels_json, value FROM metric_counters ORDER BY name, key")
    .all() as CounterRow[];
}

export function counterValue(name: string, labels: MetricLabels = {}): number {
  const row = db()
    .prepare("SELECT value FROM metric_counters WHERE key = ?")
    .get(keyFor(name, labels)) as { value: number } | undefined;
  return row?.value ?? 0;
}

/** Documented per metric family, because a scrape without HELP is a scrape nobody can read. */
const HELP: Readonly<Record<string, string>> = {
  cg_verification_total:
    "Verification gate outcomes. The metric that makes \"how often does our fix actually pass the tests?\" a number rather than a claim.",
  cg_run_total: "Analysis runs by outcome.",
  cg_findings_total: "Findings emitted, by rule and severity.",
  cg_cache_hit_ratio:
    "Content-cache hit ratio for the current process, 0..1. Sampled at scrape, not stored: it describes live state, and a counter would average it over the process lifetime.",
  cg_queue_depth: "Jobs waiting to be claimed.",
  cg_stage_duration_seconds:
    "Time spent per pipeline stage. A summary, not a histogram: `_sum` and `_count` give the mean via rate(sum)/rate(count), and buckets are not emitted because no bucket boundaries have been chosen from evidence. Percentiles are therefore unavailable, which is stated rather than faked with arbitrary buckets.",
};

/**
 * A gauge reading, supplied by the caller at scrape time.
 *
 * Counters are persisted because several processes increment them and the total must survive a
 * restart. A gauge is the opposite: it is whatever is true right now, and storing it would mean
 * serving a value that was true when some process last wrote it.
 *
 * The caller passes them in rather than this module importing them, because the sources live
 * ABOVE persistence in the layering - the content cache is in `core-graph`, the queue depth in
 * `jobs`. Reaching up for them would invert the dependency the layer rules exist to protect.
 */
export interface GaugeSample {
  name: string;
  value: number;
  labels?: MetricLabels;
}

/**
 * Counter families that are the components of a summary.
 *
 * `foo_sum` and `foo_count` are stored as ordinary counters — they are monotonic, and the
 * storage does not need to know better — but the exposition must declare `# TYPE foo summary`
 * ONCE for the base name, not `counter` twice. Prometheus rejects a duplicate TYPE line for one
 * family, so this is a correctness requirement rather than tidiness.
 */
const SUMMARY_BASES = new Set(["cg_stage_duration_seconds"]);

function summaryBaseOf(name: string): string | null {
  for (const base of SUMMARY_BASES) if (name === `${base}_sum` || name === `${base}_count`) return base;
  return null;
}

/**
 * Render the Prometheus text exposition format (v0.0.4).
 *
 * Hand-rolled rather than pulling a client library, for the reason the storage is a table:
 * the libraries all assume a single long-lived process owns the registry, which is the
 * assumption this architecture breaks. What is left to do is string formatting.
 */
export function renderPrometheus(gauges: readonly GaugeSample[] = []): string {
  const rows = allCounters();
  const lines: string[] = [];
  let currentName = "";

  const declaredSummaries = new Set<string>();
  for (const row of rows) {
    const base = summaryBaseOf(row.name);
    if (base) {
      // One TYPE line per FAMILY: `_sum` and `_count` are two series of one summary.
      if (!declaredSummaries.has(base)) {
        declaredSummaries.add(base);
        currentName = "";
        const help = HELP[base];
        if (help) lines.push(`# HELP ${base} ${help}`);
        lines.push(`# TYPE ${base} summary`);
      }
    } else if (row.name !== currentName) {
      currentName = row.name;
      const help = HELP[row.name];
      if (help) lines.push(`# HELP ${row.name} ${help}`);
      lines.push(`# TYPE ${row.name} counter`);
    }
    lines.push(`${row.key} ${formatValue(row.value)}`);
  }

  for (const g of gauges) {
    const help = HELP[g.name];
    if (help) lines.push(`# HELP ${g.name} ${help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    lines.push(`${keyFor(g.name, g.labels ?? {})} ${formatValue(g.value)}`);
  }

  // A trailing newline is required by the format; a scrape of an empty registry is still a
  // valid scrape, so this returns a newline rather than an empty body.
  return `${lines.join("\n")}\n`;
}

/**
 * Prometheus number formatting.
 *
 * The previous body was `Number.isInteger(v) ? String(v) : String(v)` - both arms identical,
 * so the branch decided nothing. It also produced `Infinity` and `NaN`, which the exposition
 * format does not accept: it wants `+Inf`, `-Inf`, `NaN`. That was theoretical while only
 * counters existed and stops being theoretical the moment a ratio gauge divides by zero, which
 * `cg_cache_hit_ratio` does on a process that has not looked anything up yet.
 */
function formatValue(value: number): string {
  // Only the infinities need translating. `String(NaN)` is already `"NaN"`, which is the
  // spelling the format wants - a NaN branch was written here, measured inert by mutation
  // testing, and removed rather than left to look load-bearing.
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

/** Reset, for tests only. Never called by application code. */
export function resetCountersForTests(): void {
  db().exec("DELETE FROM metric_counters");
}
