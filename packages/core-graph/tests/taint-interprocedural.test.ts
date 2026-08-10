import { describe, expect, it } from "vitest";
import { buildSymbolGraph } from "../src/index";
import { analyseTaint, type AnalysedFile, type TaintReport } from "../src/taint";

/**
 * Inter-procedural taint.
 *
 * The analysis this replaces asked the call graph whether a sink function was REACHABLE from a
 * handler within three hops, and called the answer data flow. The test that separates the two
 * is "index mapping, not reachability" below: it is reachable, it is not a flow, and the old
 * approach could not tell. Every case here runs real fixture sources through
 * `buildSymbolGraph`, so the symbol ids and call edges are the production ones.
 */
const f = (rel: string, text: string): AnalysedFile => ({ rel, ext: ".ts", text, language: "TypeScript" });

async function run(files: readonly AnalysedFile[]): Promise<TaintReport> {
  const graph = await buildSymbolGraph([...files], new Map());
  return analyseTaint(files, graph);
}

describe("analyseTaint", () => {
  it("follows a value across two calls and names every hop", async () => {
    const src = [
      "import { exec } from 'node:child_process';",
      "export function helper(cmd: string) {",
      "  exec(cmd);",
      "}",
      "export function handler(req: Request) {",
      "  const raw = req.body;",
      "  helper(raw);",
      "}",
    ].join("\n");
    const report = await run([f("route.ts", src)]);

    const path = report.paths.find((p) => p.sink.rule === "command-exec");
    expect(path).toBeDefined();
    expect(path?.hops.map((h) => h.name)).toEqual(["handler", "helper"]);
    expect(path?.sanitized).toBe(false);
    expect(path?.source.kind).toBe("handler-parameter");
    expect(path?.source.evidence).toBe("req: Request");
    expect(path?.sink.evidence).toBe("exec(cmd)");
    expect(path?.sink.line).toBe(3);
    // The hop chain is the caller's file/line, not the sink's — it is what you click on.
    expect(path?.hops[0]?.symbolId).toContain("route.ts#handler@");
  });

  it("keeps a defended path and marks it sanitized rather than dropping it", async () => {
    // Dropping it would make "we found nothing" and "we found a defence" look identical, which
    // is the same class of dishonesty as a fabricated finding.
    const src = [
      "import { exec } from 'node:child_process';",
      "export function escapeShell(v: string) { return v.replace(/'/g, ''); }",
      "export function helper(cmd: string) {",
      "  exec(escapeShell(cmd));",
      "}",
      "export function handler(req: Request) {",
      "  helper(req.body);",
      "}",
    ].join("\n");
    const report = await run([f("safe.ts", src)]);

    const path = report.paths.find((p) => p.sink.rule === "command-exec");
    expect(path).toBeDefined();
    expect(path?.sanitized).toBe(true);
    expect(path?.hops.map((h) => h.name)).toEqual(["handler", "helper"]);
  });

  it("maps arguments to parameters by INDEX, so a sink on the other parameter is not a flow", async () => {
    // The decisive case. `handler` reaches `consume` and `consume` reaches `exec`, so every
    // reachability-based analysis reports this. The tainted value is bound to `b`; the sink
    // consumes `a`; there is no flow. Reporting it is the false positive that made the
    // previous implementation unusable.
    const src = [
      "import { exec } from 'node:child_process';",
      "export function consume(a: string, b: string) {",
      "  exec(a);",
      "}",
      "export function handler(req: Request) {",
      "  consume('ls -la', req.body);",
      "}",
    ].join("\n");
    const report = await run([f("index.ts", src)]);
    expect(report.paths).toEqual([]);
  });

  it("does report the same shape when the sink consumes the TAINTED parameter", async () => {
    // Control for the case above: without this, "reports nothing" could just mean "broken".
    const src = [
      "import { exec } from 'node:child_process';",
      "export function consume(a: string, b: string) {",
      "  exec(b);",
      "}",
      "export function handler(req: Request) {",
      "  consume('ls -la', req.body);",
      "}",
    ].join("\n");
    const report = await run([f("index2.ts", src)]);
    expect(report.paths.map((p) => p.sink.rule)).toEqual(["command-exec"]);
    expect(report.paths[0]?.hops.map((h) => h.name)).toEqual(["handler", "consume"]);
  });

  it("carries a tainted RETURN value back to the caller", async () => {
    // Load-bearing precisely here: the sink sits inside a callback, so `classifyTaint`'s
    // enclosing body is the arrow and the `const derived = ...` assignment is out of its
    // sight. Only the returned-taint fact, held on the caller's frame, makes it visible.
    const src = [
      "import { exec } from 'node:child_process';",
      "export function producer(v: string) {",
      "  return v + '!';",
      "}",
      "export function handler(req: Request) {",
      "  const derived = producer(req.query);",
      "  ['a'].forEach(() => { exec(derived); });",
      "}",
    ].join("\n");
    const report = await run([f("ret.ts", src)]);

    const path = report.paths.find((p) => p.sink.rule === "command-exec");
    expect(path).toBeDefined();
    expect(path?.sink.line).toBe(7);
    expect(path?.hops.map((h) => h.name)).toEqual(["handler"]);
  });

  it("reports truncation instead of an answer when a chain outruns the depth cap", async () => {
    const src = [
      "import { exec } from 'node:child_process';",
      "export function e(x: string) { exec(x); }",
      "export function d(x: string) { e(x); }",
      "export function c(x: string) { d(x); }",
      "export function b(x: string) { c(x); }",
      "export function a(x: string) { b(x); }",
      "export function handler(req: Request) { a(req.body); }",
    ].join("\n");
    const report = await run([f("deep.ts", src)]);

    expect(report.truncated).toBe(true);
    expect(report.paths.some((p) => p.sink.rule === "command-exec")).toBe(false);
  });

  it("derives confidence: a short resolved chain outranks a long one", async () => {
    const shortSrc = [
      "import { exec } from 'node:child_process';",
      "export function handler(req: Request) { exec(req.body); }",
    ].join("\n");
    const shortReport = await run([f("short.ts", shortSrc)]);

    const longReport = await run([
      f("a.ts", "import { one } from './b';\nexport function handler(req: Request) { one(req.body); }\n"),
      f("b.ts", "import { two } from './c';\nexport function one(x: string) { two(x); }\n"),
      f("c.ts", "import { three } from './d';\nexport function two(x: string) { three(x); }\n"),
      f("d.ts", "import { exec } from 'node:child_process';\nexport function three(x: string) { exec(x); }\n"),
    ]);

    const shortPath = shortReport.paths.find((p) => p.sink.rule === "command-exec");
    const longPath = longReport.paths.find((p) => p.sink.rule === "command-exec");
    expect(shortPath).toBeDefined();
    expect(longPath).toBeDefined();
    expect(longPath?.hops.map((h) => h.name)).toEqual(["handler", "one", "two", "three"]);
    // Ordering, not a magic number: the number is derived and will move when the weights do.
    expect(shortPath!.confidence).toBeGreaterThan(longPath!.confidence);
    expect(longPath!.confidence).toBeGreaterThan(0);
  });

  it("finds a non-request source and names it honestly", async () => {
    const src = [
      "import { exec } from 'node:child_process';",
      "export function boot() {",
      "  exec(process.argv[2]);",
      "}",
    ].join("\n");
    const report = await run([f("boot.ts", src)]);
    expect(report.paths.map((p) => p.source.kind)).toEqual(["process-argv"]);
    // Evidence is the exact expression read, not the pattern that matched it.
    expect(report.paths[0]?.source.evidence).toBe("process.argv[2]");
  });

  it("does not flag a sink fed by an internal constant", async () => {
    const src = [
      "import { exec } from 'node:child_process';",
      "const CMD = 'git status';",
      "export function run2() { exec(CMD); }",
    ].join("\n");
    const report = await run([f("clean.ts", src)]);
    expect(report.paths).toEqual([]);
    expect(report.truncated).toBe(false);
  });

  it("returns a deterministic, bounded report", async () => {
    const src = [
      "import { exec } from 'node:child_process';",
      "export function handler(req: Request) { exec(req.body); }",
    ].join("\n");
    const files = [f("det.ts", src)];
    const first = await run(files);
    const second = await run(files);
    expect(first.paths.map((p) => p.id)).toEqual(second.paths.map((p) => p.id));
    expect(first.analysedSymbols).toBeGreaterThan(0);
  });
});

describe("callee names that collide with Object.prototype", () => {
  /**
   * THE CRASH THIS PINS. The sink table was a `Record<string, SinkSpec>` object literal indexed
   * by the callee's name, so `CALL_SINKS["constructor"]` returned `Object.prototype.constructor`
   * — truthy, and with no `args` — and the very next line did `for (const i of spec.args)`.
   * `TypeError: spec.args is not iterable`, thrown out of `indexRepo`, on ordinary code.
   *
   * Every fixture in this file used ordinary function names, so nothing caught it until the
   * analysis was run over a real repository. `toString`, `valueOf`, `hasOwnProperty` and
   * `constructor` are all legal method names that appear in real source, and the input here is
   * an attacker-authored repository — a crash is a denial of the whole index, not a bad answer.
   */
  const PROTOTYPE_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it.each(PROTOTYPE_NAMES)("survives a call to %s()", async (name) => {
    const src = [
      `export function handler(req: Request) {`,
      `  const v = req.body;`,
      `  return (v as { ${name}: (x: unknown) => unknown }).${name}(v);`,
      `}`,
    ].join("\n");
    const report = await run([f("proto.ts", src)]);
    expect(report.paths).toBeInstanceOf(Array);
  });

  it("does not treat a prototype member as a sink", async () => {
    // The other half: not crashing is not enough. `Object.prototype.constructor` must not be
    // mistaken for a configured sink and produce a fabricated finding.
    const src = [
      "export function handler(req: Request) {",
      "  const v = req.body;",
      "  return v.constructor(v);",
      "}",
    ].join("\n");
    const report = await run([f("proto2.ts", src)]);
    expect(report.paths.filter((p) => p.sink.rule !== "")).toEqual([]);
  });
});
