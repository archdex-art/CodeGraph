import { runFix } from "./fix";
import { color } from "./ui/ansi";

const { bold, dim, green, red, yellow } = color;

/**
 * `codegraph` — the CLI entry point (LLD §1, `terminal/` → `apps/cli`).
 *
 * Argument parsing is hand-rolled. The surface is one command with five flags, and a parser
 * dependency for that is more supply chain than the feature is worth in a project whose pitch
 * includes "no API key, one container".
 */

const USAGE = `${bold("codegraph")} — a codebase workbench

${bold("USAGE")}
  codegraph fix [path] [options]

${bold("WHY THIS EXISTS")}
  Gate 3 of verification runs your repository's own test suite, which needs an isolated
  container. The hosted demo cannot provide one, so it reports ${yellow("verified: partial")}.
  Here, on your machine, with your toolchain — it reports ${green("verified: full")}.

  Your source is never modified. You get a diff.

${bold("OPTIONS")}
  --verify              run your test suite as gate 3 (this is the point)
  --rule <id>           only fix findings of this rule
  --file <path>         only fix this file (repo-relative)
  --test-timeout <s>    seconds before gate 3 is SIGKILLed (default 300)
  --json                machine-readable output
  -h, --help            this

${bold("EXAMPLES")}
  codegraph fix . --verify
  codegraph fix ~/src/app --rule legacy/leftover-debug-output --verify
  codegraph fix . --verify --json | jq .record.level
`;

interface Parsed {
  readonly command: string | null;
  readonly path: string;
  readonly verify: boolean;
  readonly rule?: string;
  readonly file?: string;
  readonly json: boolean;
  readonly testTimeout: number;
  readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): Parsed {
  let command: string | null = null;
  let target = ".";
  let verify = false;
  let json = false;
  let help = false;
  let rule: string | undefined;
  let file: string | undefined;
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
      json = true;
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
    testTimeout,
    help,
    ...(rule !== undefined ? { rule } : {}),
    ...(file !== undefined ? { file } : {}),
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

  if (args.command !== "fix") {
    process.stderr.write(`${red("error")}: unknown command "${args.command}". Try --help.\n`);
    return 2;
  }

  try {
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
