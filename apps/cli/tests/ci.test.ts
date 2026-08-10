import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASELINE_FILE, runBaseline } from "../src/ci";
import { main, parseArgs } from "../src/main";

/**
 * `codegraph ci` / `codegraph baseline` — the gate a pull request runs.
 *
 * Everything here goes through `main()` rather than `runCi()`, because the contract a CI runner
 * depends on is the EXIT CODE and nothing else. A summary that says FAIL while `main` returns 0
 * is a green build on a rejected change, and only an end-to-end assertion catches that.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A repo with findings at three tiers, and two instances of ONE rule in ONE file.
 *
 * That duplication is load-bearing: `findingKey` is rule+file, so those two findings collapse
 * to a single baseline entry. Any fixture with one finding per file would let a baseline that
 * counts entries and one that counts findings agree, and the difference is what the adopter is
 * actually deciding on.
 */
function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-ci-test-"));
  trees.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src/db.js"),
    [
      'import fs from "node:fs";',
      "",
      "export function find(db, name) {",
      // codegraph-ignore sql-concatenation — a fixture string, not a query this repo runs
      '  return db.query("SELECT * FROM users WHERE name = " + name);',
      "}",
      "",
      "export function audit(db, id) {",
      // Same rule, same file -> one baseline entry, two findings. That is the point of it.
      // codegraph-ignore sql-concatenation — a fixture string, not a query this repo runs
      '  return db.query("SELECT * FROM audit WHERE id = " + id);',
      "}",
      "",
      "export function load(p) {",
      // low: security/detect-non-literal-fs-filename
      '  return fs.readFileSync(p, "utf8");',
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
  return root;
}

/** Run the CLI exactly as `bin.mjs` does and keep what it printed. */
async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  try {
    return { code: await main(argv), out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

describe("parseArgs — the ci surface", () => {
  it("takes a path for --json after `ci` and a boolean after `fix`", () => {
    // The one flag whose arity depends on the command. Getting this wrong means `ci --json f`
    // swallows `f` as the positional path and analyses a directory that does not exist.
    expect(parseArgs(["ci", "--json", "out.json"]).jsonPath).toBe("out.json");
    expect(parseArgs(["ci", "--json", "out.json"]).path).toBe(".");
    expect(parseArgs(["fix", "--json"]).json).toBe(true);
    expect(parseArgs(["fix", "--json"]).jsonPath).toBeUndefined();
  });

  it("defaults the gate to high and the baseline to the conventional filename", () => {
    const a = parseArgs(["ci"]);
    expect(a.failOn).toBe("high");
    expect(a.baseline).toBe(BASELINE_FILE);
  });

  it("rejects an unknown tier rather than quietly gating on high", () => {
    // `--fail-on critical` meant "stricter". Defaulting it to `high` would be a weaker gate
    // than the author asked for, silently.
    expect(() => parseArgs(["ci", "--fail-on", "critical"])).toThrow(/high, medium or low/);
    expect(() => parseArgs(["ci", "--fail-on"])).toThrow(/expects a value/);
  });
});

describe("the exit code is the verdict", () => {
  it("exits 1 on unaccepted high-confidence findings and names them", async () => {
    const root = repo();
    const { code, out } = await run("ci", root);

    expect(code).toBe(1);
    expect(out).toContain("FAIL");
    // Score, tiers and top rules are the summary's contract, not decoration.
    expect(out).toMatch(/Health\s+\d{1,3}\/100/);
    expect(out).toMatch(/Tiers\s+high 2 /);
    expect(out).toContain("Top rules");
    expect(out).toContain("sql-concatenation");
    // Evidence, so a reviewer can falsify the finding without opening the file.
    expect(out).toContain("SELECT * FROM users WHERE name = ");
  });

  it("gates strictly more at a lower tier", async () => {
    const root = repo();
    const high = await run("ci", root);
    const low = await run("ci", root, "--fail-on", "low");

    expect(low.code).toBe(1);
    const count = (s: string) => Number(/FAIL — (\d+) unaccepted/.exec(s)?.[1]);
    expect(count(low.out)).toBeGreaterThan(count(high.out));
    expect(low.out).toContain("--fail-on low");
  });

  it("exits 2 on a bad invocation — not 1, which a runner reads as a failed gate", async () => {
    const { code, err } = await run("ci", "--fail-on", "critical");
    expect(code).toBe(2);
    expect(err).toContain("error");
  });

  it("refuses a path that is not a directory instead of passing on nothing", async () => {
    // The real bug: `ci ./aps/web` indexed a directory that does not exist, found no findings,
    // scored 100 and exited 0. A green build on a path that was never analysed.
    const { code, err } = await run("ci", path.join(tmpdir(), "cg-definitely-not-here"));
    expect(code).toBe(2);
    expect(err).toContain("is not a directory");
  });

  it("exits 0 once a baseline accepts today's findings, and reports what it accepted", async () => {
    const root = repo();
    expect((await run("ci", root)).code).toBe(1);

    const wrote = await run("baseline", root);
    expect(wrote.code).toBe(0);
    expect(existsSync(path.join(root, BASELINE_FILE))).toBe(true);

    const { code, out } = await run("ci", root);
    expect(code).toBe(0);
    expect(out).toContain("no unaccepted findings");
    // Accepted findings are REPORTED, never dropped: the count and the file are both stated.
    expect(out).toMatch(/Findings\s+0 active · \d+ accepted \(\.codegraph-baseline\.json: \d+\)/);
    expect(out).toContain("accepted");
  });

  it("counts findings accepted, not baseline entries", async () => {
    // The bug this pins: `findingKey` is rule+file, so the two sql-concatenation findings in
    // src/db.js are ONE entry. Reporting "1 finding accepted" understated the adoption by half.
    const root = repo();
    const out = await runBaseline({ repo: root, baseline: BASELINE_FILE });

    const written: { accepted: string[] } = JSON.parse(
      readFileSync(path.join(root, BASELINE_FILE), "utf8")
    );
    expect(written.accepted).toContain("sql-concatenation::src/db.js");
    expect(out.entries).toBe(written.accepted.length);
    expect(out.covered).toBeGreaterThan(out.entries);
  });

  it("merges into an existing baseline instead of replacing it", async () => {
    // Running it twice must not re-open what the first run accepted: `indexRepo` applies the
    // file on disk before this sees the findings, so the fresh set alone would be empty.
    const root = repo();
    const first = await runBaseline({ repo: root, baseline: BASELINE_FILE });
    const second = await runBaseline({ repo: root, baseline: BASELINE_FILE });

    expect(second.entries).toBe(first.entries);
    expect(second.added).toBe(0);
  });

  it("honours a non-default --baseline path", async () => {
    // `indexRepo` only ever applies `<root>/.codegraph-baseline.json`; a custom path is honoured
    // by `runCi` alone, so it is the only thing keeping `--baseline` from being decorative.
    const root = repo();
    mkdirSync(path.join(root, "ci"));
    await run("baseline", root, "--baseline", "ci/accepted.json");

    expect(existsSync(path.join(root, "ci/accepted.json"))).toBe(true);
    // The default filename was never written, so a plain `ci` must still fail.
    expect(existsSync(path.join(root, BASELINE_FILE))).toBe(false);
    expect((await run("ci", root)).code).toBe(1);
    expect((await run("ci", root, "--baseline", "ci/accepted.json")).code).toBe(0);
  });
});

describe("the SARIF log GitHub code scanning reads", () => {
  interface Sarif {
    $schema: string;
    version: string;
    runs: {
      tool: { driver: { name: string; rules: { id: string; shortDescription: { text: string } }[] } };
      results: {
        ruleId: string;
        level: string;
        locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
        properties: { evidence?: string };
        suppressions?: { kind: string }[];
      }[];
      invocations: { executionSuccessful: boolean }[];
    }[];
  }

  const read = (f: string): Sarif => JSON.parse(readFileSync(f, "utf8")) as Sarif;

  it("is a well-formed 2.1.0 log whose every ruleId resolves", async () => {
    const root = repo();
    const log = path.join(root, "out.sarif");
    await run("ci", root, "--fail-on", "low", "--sarif", log);
    const sarif = read(log);

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-2.1.0");
    expect(sarif.runs).toHaveLength(1);
    const run0 = sarif.runs[0]!;
    expect(run0.tool.driver.name).toBe("CodeGraph");
    expect(run0.results.length).toBeGreaterThan(0);
    expect(run0.invocations[0]?.executionSuccessful).toBe(true);

    // A dangling ruleId is the failure GitHub rejects the upload on, and it is invisible in
    // any test that only counts results.
    const declared = new Set(run0.tool.driver.rules.map((r) => r.id));
    expect(declared.size).toBe(run0.tool.driver.rules.length);
    for (const r of run0.results) expect(declared.has(r.ruleId)).toBe(true);
  });

  it("uses the stable rule id, not a slug of the title", async () => {
    // Titles are prose and get reworded; a ruleId derived from one silently re-opens every
    // alert a team had triaged. `Issue.rule` is the identity the baseline keys on too.
    const root = repo();
    const log = path.join(root, "out.sarif");
    await run("ci", root, "--fail-on", "low", "--sarif", log);
    const run0 = read(log).runs[0]!;

    const sql = run0.results.find((r) => r.ruleId === "sql-concatenation");
    expect(sql).toBeDefined();
    expect(sql!.locations[0]!.physicalLocation.artifactLocation.uri).toBe("src/db.js");
    expect(sql!.properties.evidence).toContain("SELECT");
    // The declared rule keeps the human title; the id stays machine-stable.
    const rule = run0.tool.driver.rules.find((r) => r.id === "sql-concatenation");
    expect(rule?.shortDescription.text).not.toBe("sql-concatenation");
  });

  it("marks accepted findings suppressed rather than dropping them", async () => {
    const root = repo();
    const before = path.join(root, "before.sarif");
    const after = path.join(root, "after.sarif");

    await run("ci", root, "--fail-on", "low", "--sarif", before);
    expect(read(before).runs[0]!.results.some((r) => r.suppressions)).toBe(false);

    await run("baseline", root);
    await run("ci", root, "--fail-on", "low", "--sarif", after);
    const run0 = read(after).runs[0]!;

    // Same number of results as before the baseline — a baseline that made alerts vanish is an
    // allowlist nobody reviews. They are marked, and `external` is what makes code scanning
    // show them as dismissed.
    expect(run0.results).toHaveLength(read(before).runs[0]!.results.length);
    expect(run0.results.every((r) => r.suppressions?.[0]?.kind === "external")).toBe(true);
  });
});
