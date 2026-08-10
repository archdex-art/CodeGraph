import { statSync } from "node:fs";
import path from "node:path";
import type { ConfidenceTier } from "@codegraph/analysis-model";
import { runBaseline, runCi, BASELINE_FILE, type CiSummary } from "./ci";
import { runFix } from "./fix";
import { color, padEnd, truncate } from "./ui/ansi";

const { bold, dim, green, red, yellow } = color;

/**
 * `codegraph` — the CLI entry point (LLD §1, `terminal/` → `apps/cli`).
 *
 * Argument parsing is hand-rolled. The surface is three commands and nine flags, and a parser
 * dependency for that is more supply chain than the feature is worth in a project whose pitch
 * includes "no API key, one container".
 *
 * `--json` is the one flag whose arity depends on the command: a boolean for `fix` (dump the
 * outcome to stdout), a path for `ci` (the file the PR comment is built from). Resolved by
 * reading the command first, which means options must FOLLOW the command — as every line of
 * the usage above shows. `codegraph --json out.json ci` fails loudly with
 * `unknown command "out.json"` rather than doing something surprising.
 */

const USAGE = `${bold("codegraph")} — a codebase workbench

${bold("USAGE")}
  codegraph ci [path] [options]
  codegraph baseline [path] [options]
  codegraph fix [path] [options]

${bold("ci")} — fail a change on findings, not on a score
  A score threshold fails a pull request for debt its author did not write. This gates on
  UNACCEPTED findings at or above a confidence tier, each carrying one line of evidence you
  can check without opening the file. Exit ${red("1")} when the gate fires, ${green("0")} when it does not.

  --fail-on <tier>      high | medium | low (default high)
  --baseline <path>     accepted findings (default ${BASELINE_FILE})
  --sarif <path>        write a SARIF 2.1.0 log — GitHub code scanning reads this
  --json <path>         write the summary as JSON (what the PR comment is built from)

${bold("baseline")} — adopt the gate on a codebase that already has findings
  Accepts everything present today, so the gate starts green and fires on what you add next.
  Accepted findings are still reported and still excluded from the Health Score — the file is
  an audit trail, not an allowlist that hides things.

  --baseline <path>     file to write (default ${BASELINE_FILE})

${bold("fix")} — remediation verified where you already are
  Gate 3 of verification runs your repository's own test suite, which needs an isolated
  container. The hosted demo cannot provide one, so it reports ${yellow("verified: partial")}.
  Here, on your machine, with your toolchain — it reports ${green("verified: full")}.

  Your source is never modified. You get a diff.

  --verify              run your test suite as gate 3 (this is the point)
  --rule <id>           only fix findings of this rule
  --file <path>         only fix this file (repo-relative)
  --test-timeout <s>    seconds before gate 3 is SIGKILLed (default 300)
  --json                machine-readable output

${bold("OPTIONS")}
  -h, --help            this

${bold("EXAMPLES")}
  codegraph ci . --fail-on high --sarif codegraph.sarif
  codegraph baseline .
  codegraph fix . --verify
  codegraph fix ~/src/app --rule legacy/leftover-debug-output --verify
`;

interface Parsed {
  readonly command: string | null;
  readonly path: string;
  readonly verify: boolean;
  readonly rule?: string;
  readonly file?: string;
  /** `fix`: dump the outcome to stdout. */
  readonly json: boolean;
  /** `ci`: write the summary here. */
  readonly jsonPath?: string;
  readonly sarif?: string;
  readonly failOn: ConfidenceTier;
  readonly baseline: string;
  readonly testTimeout: number;
  readonly help: boolean;
}

const TIERS: Record<string, ConfidenceTier> = { high: "high", medium: "medium", low: "low" };

export function parseArgs(argv: readonly string[]): Parsed {
  let command: string | null = null;
  let target = ".";
  let verify = false;
  let json = false;
  let help = false;
  let rule: string | undefined;
  let file: string | undefined;
  let jsonPath: string | undefined;
  let sarif: string | undefined;
  let failOn: ConfidenceTier = "high";
  let baseline = BASELINE_FILE;
  let testTimeout = 300;
  let sawPositional = false;

  /**
   * The value after a flag, or a clear error.
   *
   * `argv[++i]` alone is `string | undefined`, and taking it unchecked means
   * `codegraph fix --rule` (no value) silently binds undefined and then runs every fixer —
   * the opposite of what was asked for. The compiler flagged this; it is a real bug, not a
   * strictness complaint.
   */
  const valueFor = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) {
      throw new Error(`${flag} expects a value.`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "-h" || a === "--help") {
      help = true;
    } else if (a === "--verify") {
      verify = true;
    } else if (a === "--json") {
      // Arity by command — see the note at the top of this file.
      if (command === "ci") jsonPath = valueFor("--json", ++i);
      else json = true;
    } else if (a === "--sarif") {
      sarif = valueFor("--sarif", ++i);
    } else if (a === "--baseline") {
      baseline = valueFor("--baseline", ++i);
    } else if (a === "--fail-on") {
      const raw = valueFor("--fail-on", ++i);
      // Rejected rather than defaulted: `--fail-on hgih` quietly gating on `high` is fine, and
      // `--fail-on critical` quietly gating on `high` when the author meant "stricter" is not.
      const tier = TIERS[raw];
      if (tier === undefined) {
        throw new Error(`--fail-on expects high, medium or low, got "${raw}"`);
      }
      failOn = tier;
    } else if (a === "--rule") {
      rule = valueFor("--rule", ++i);
    } else if (a === "--file") {
      file = valueFor("--file", ++i);
    } else if (a === "--test-timeout") {
      const raw = valueFor("--test-timeout", ++i);
      const n = Number(raw);
      // Rejected rather than coerced: `--test-timeout abc` silently becoming NaN and then the
      // default is how a developer thinks they capped a run that is actually uncapped.
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--test-timeout expects a positive number of seconds, got "${raw}"`);
      }
      testTimeout = n;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option "${a}". Try --help.`);
    } else if (command === null) {
      command = a;
    } else if (!sawPositional) {
      target = a;
      sawPositional = true;
    } else {
      throw new Error(`Unexpected argument "${a}".`);
    }
  }

  return {
    command,
    path: target,
    verify,
    json,
    failOn,
    baseline,
    testTimeout,
    help,
    ...(rule !== undefined ? { rule } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(jsonPath !== undefined ? { jsonPath } : {}),
    ...(sarif !== undefined ? { sarif } : {}),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Parsed;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${red("error")}: ${(e as Error).message}\n`);
    return 2;
  }

  if (args.help || args.command === null) {
    process.stdout.write(USAGE);
    return args.command === null && !args.help ? 2 : 0;
  }

  if (args.command !== "fix" && args.command !== "ci" && args.command !== "baseline") {
    process.stderr.write(`${red("error")}: unknown command "${args.command}". Try --help.\n`);
    return 2;
  }

  // A gate that green-lights a typo is worse than no gate. `codegraph ci ./aps/web` indexed a
  // directory that does not exist, found nothing, scored 100 and exited 0 — the build went
  // green on a path that was never analysed. Exit 2, because a bad argument is a usage error
  // and not a verdict on any code.
  if (!statSync(path.resolve(args.path), { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`${red("error")}: "${args.path}" is not a directory.\n`);
    return 2;
  }

  try {
    if (args.command === "ci") {
      const summary = await runCi({
        repo: args.path,
        failOn: args.failOn,
        baseline: args.baseline,
        ...(args.sarif !== undefined ? { sarif: args.sarif } : {}),
        ...(args.jsonPath !== undefined ? { json: args.jsonPath } : {}),
      });
      process.stdout.write(renderCi(summary));
      // EXIT CODE IS THE VERDICT. Everything else this command prints is advisory; the number
      // the CI runner reads is this one, and it comes from `gateFindings` alone.
      return summary.passed ? 0 : 1;
    }

    if (args.command === "baseline") {
      const out = await runBaseline({ repo: args.path, baseline: args.baseline });
      // Entries AND findings. A baseline entry is rule+file, so "3 entries" routinely accepts
      // twenty findings; printing only the entry count told the reader they were signing off on
      // far less than they were.
      process.stdout.write(
        `${bold("Wrote")} ${out.file}\n` +
          `${out.entries} entr${out.entries === 1 ? "y" : "ies"} accepting ${out.covered} finding(s)` +
          `${out.added === out.entries ? "" : ` (${out.added} new)`}.\n` +
          `${bold("Health")} ${out.score}/100 as analysed, before these were accepted.\n` +
          `${dim("Still reported, still out of the Health Score. The gate now fires on what you add next.")}\n`
      );
      return 0;
    }

    const out = await runFix({
      repo: args.path,
      verify: args.verify,
      json: args.json,
      testTimeout: args.testTimeout,
      ...(args.rule !== undefined ? { rule: args.rule } : {}),
      ...(args.file !== undefined ? { file: args.file } : {}),
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    } else {
      process.stdout.write(render(out));
    }

    // EXIT CODE IS THE VERDICT, because that is what a pre-commit hook or a CI step reads.
    // A failed gate is exit 1 even though the command itself ran fine: "the patch was
    // rejected" is a failure to the caller, and returning 0 there would make the gate
    // decorative in exactly the way review C3 was about.
    if (out.record === null) return 0;
    if (out.record.gates.some((g) => g.status === "failed")) return 1;
    return 0;
  } catch (e) {
    process.stderr.write(`${red("error")}: ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * The summary a developer reads in a terminal and a reviewer reads in CI logs.
 *
 * Ordered by what changes a decision: the verdict's inputs first, then the rules costing the
 * most, then the individual findings that are actually failing the build. The Health Score is
 * printed and NOT the verdict — it is context for the number, not the number.
 */
function renderCi(s: CiSummary): string {
  const tier = (t: string, n: number) => (n === 0 ? dim(`${t} ${n}`) : `${t} ${bold(n)}`);
  const lines = [
    `${bold("Health")}     ${s.score}/100   ${dim(s.repo)}`,
    `${bold("Findings")}   ${s.active} active · ${s.accepted} accepted${
      s.baselineFile ? dim(` (${s.baselineFile}: ${s.acceptedByBaseline})`) : ""
    }`,
    `${bold("Tiers")}      ${tier("high", s.tiers.high)} · ${tier("medium", s.tiers.medium)} · ${tier("low", s.tiers.low)}`,
  ];

  if (s.rules.length > 0) {
    lines.push("", bold("Top rules"));
    for (const r of s.rules.slice(0, 5)) {
      const acc = r.suppressed > 0 ? dim(` ${r.suppressed} accepted`) : "";
      lines.push(`  ${padEnd(String(r.count), 4)}${padEnd(truncate(r.rule, 44), 46)}${dim(r.tier)}${acc}`);
    }
  }

  lines.push("", `${bold("Gate")}       ${dim(`--fail-on ${s.failOn}`)}`);
  if (s.passed) {
    lines.push(`  ${green("✓")} no unaccepted findings at or above ${s.failOn} confidence.`);
  } else {
    // Five, not all of them: a wall of findings is a wall nobody reads, and the full set is in
    // the SARIF and the JSON summary for anyone who wants it.
    for (const f of s.gating.slice(0, 5)) {
      lines.push(`  ${red("✗")} ${bold(`${f.file}:${f.line}`)}  ${f.rule} ${dim(f.tier)}`);
      lines.push(`      ${dim(f.evidence ?? f.title)}`);
    }
    if (s.gatingCount > 5) lines.push(dim(`  … and ${s.gatingCount - 5} more`));
    lines.push(
      "",
      `${red("FAIL")} — ${s.gatingCount} unaccepted finding(s) at or above ${s.failOn} confidence.`,
      dim("Fix them, add `codegraph-ignore` with a reason, or run `codegraph baseline` to accept today's.")
    );
  }

  return `${lines.join("\n")}\n`;
}

function render(out: Awaited<ReturnType<typeof runFix>>): string {
  const lines: string[] = [];
  if (out.editCount === 0) {
    lines.push(`${dim("·")} ${out.summary}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `${bold("Applied")} ${out.editCount} edit(s) across ${out.filesChanged} file(s)`,
    `${bold("Health")}  ${out.scoreBefore} → ${out.scoreAfter}   ${dim(
      `${out.issuesBefore} → ${out.issuesAfter} issues`
    )}`,
    ""
  );

  if (out.record) {
    // The same distinction the web UI now draws — `partial` must never read as `full`.
    const level = out.record.gates.some((g) => g.status === "failed")
      ? red("failed")
      : out.record.level === "full"
        ? green("full")
        : yellow(out.record.level);
    lines.push(`${bold("Verification")}: ${level}`);
    for (const g of out.record.gates) {
      const mark =
        g.status === "passed" ? green("✓") : g.status === "failed" ? red("✗") : dim("−");
      const why = g.reason ? dim(` — ${g.reason}`) : "";
      lines.push(`  ${mark} ${g.gate.padEnd(11)}${dim(`${g.ms}ms`)}${why}`);
    }
    lines.push("");
    if (out.record.level !== "full") {
      lines.push(
        dim("Not every gate ran. Pass --verify to run your test suite as gate 3."),
        ""
      );
    }
  }

  lines.push(dim("Diff follows — pipe to `git apply` to accept."), "", out.diff);
  return `${lines.join("\n")}\n`;
}
