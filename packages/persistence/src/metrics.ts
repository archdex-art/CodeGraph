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
};

/**
 * Render the Prometheus text exposition format (v0.0.4).
 *
 * Hand-rolled rather than pulling a client library, for the reason the storage is a table:
 * the libraries all assume a single long-lived process owns the registry, which is the
 * assumption this architecture breaks. What is left to do is string formatting.
 */
export function renderPrometheus(): string {
  const rows = allCounters();
  const lines: string[] = [];
  let currentName = "";

  for (const row of rows) {
    if (row.name !== currentName) {
      currentName = row.name;
      const help = HELP[row.name];
      if (help) lines.push(`# HELP ${row.name} ${help}`);
      lines.push(`# TYPE ${row.name} counter`);
    }
    lines.push(`${row.key} ${formatValue(row.value)}`);
  }

  // A trailing newline is required by the format; a scrape of an empty registry is still a
  // valid scrape, so this returns a newline rather than an empty body.
  return `${lines.join("\n")}\n`;
}

/** Integers render without a decimal point; anything else keeps full precision. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

/** Reset, for tests only. Never called by application code. */
export function resetCountersForTests(): void {
  db().exec("DELETE FROM metric_counters");
}
