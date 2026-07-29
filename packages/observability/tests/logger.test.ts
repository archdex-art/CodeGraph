import { describe, expect, it } from "vitest";
import { createLogger, serializeError, type LogFields } from "../src/index";

/** Collects emitted lines so assertions can be made on real output. */
function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    now: () => 1_700_000_000_000,
  });
  return {
    logger,
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("log line shape", () => {
  it("emits exactly one JSON line per event", () => {
    const { logger, lines } = capture();
    logger.warn("first");
    logger.warn("second");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("\n");
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("carries level, ISO time, and message", () => {
    const { logger, parsed } = capture();
    logger.error("boom");
    expect(parsed()[0]).toMatchObject({
      level: "error",
      msg: "boom",
      time: "2023-11-14T22:13:20.000Z",
    });
  });

  it("supports all four levels", () => {
    const { logger, parsed } = capture();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(parsed().map((p) => p["level"])).toEqual(["debug", "info", "warn", "error"]);
  });

  it("merges caller fields into the line", () => {
    const { logger, parsed } = capture();
    logger.info("indexed", { files: 42, repo: "octocat/Hello-World" });
    expect(parsed()[0]).toMatchObject({ files: 42, repo: "octocat/Hello-World" });
  });
});

describe("child bindings — the mechanism behind HLD G7", () => {
  it("puts bound context on every subsequent line", () => {
    // The reason this exists: a failure must be attributable to a stage without
    // the call site restating the run id every time.
    const { logger, parsed } = capture();
    const scoped = logger.child({ runId: "run_1", stage: "parse" });
    scoped.warn("budget exhausted");
    scoped.error("gave up");
    for (const line of parsed()) {
      expect(line).toMatchObject({ runId: "run_1", stage: "parse" });
    }
  });

  it("nests, with the innermost binding winning", () => {
    const { logger, parsed } = capture();
    logger.child({ runId: "r", stage: "parse" }).child({ stage: "detect" }).info("x");
    expect(parsed()[0]).toMatchObject({ runId: "r", stage: "detect" });
  });

  it("does not mutate the parent logger", () => {
    // A child that reconfigured its parent would be exactly the cross-request
    // state bleed behind review item B4.
    const { logger, parsed } = capture();
    logger.child({ runId: "r" }).info("child line");
    logger.info("parent line");
    expect(parsed()[1]).not.toHaveProperty("runId");
  });

  it("lets an explicit field override a binding", () => {
    const { logger, parsed } = capture();
    logger.child({ stage: "parse" }).info("x", { stage: "override" });
    expect(parsed()[0]).toMatchObject({ stage: "override" });
  });
});

describe("error serialisation", () => {
  it("records message and stack, which JSON.stringify alone drops", () => {
    // `JSON.stringify(new Error("x"))` is "{}" because message and stack are
    // non-enumerable. Logging an error without handling that records nothing at
    // all — the bug this guards.
    expect(JSON.stringify(new Error("invisible"))).toBe("{}");

    const { logger, parsed } = capture();
    logger.error("clone failed", { err: new Error("repository not found") });
    const err = parsed()[0]?.["err"] as Record<string, unknown>;
    expect(err["name"]).toBe("Error");
    expect(err["message"]).toBe("repository not found");
    expect(typeof err["stack"]).toBe("string");
  });

  it("follows a cause chain", () => {
    const root = new Error("ENOENT");
    const wrapped = new Error("could not read workspace", { cause: root });
    const out = serializeError(wrapped);
    expect(out).toMatchObject({ message: "could not read workspace", cause: { message: "ENOENT" } });
  });

  it("bounds a cyclic cause chain instead of recursing forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(() => serializeError(a)).not.toThrow();
  });

  it("stringifies non-Error throwables", () => {
    expect(serializeError("just a string")).toBe("just a string");
    expect(serializeError(undefined)).toBe("undefined");
    expect(serializeError(42)).toBe("42");
  });
});

describe("robustness", () => {
  it("never lets an unserialisable field throw out of a log call", () => {
    // A log line failing must not become the outage. This is the whole reason
    // the emit path has a fallback.
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), now: () => 0 });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => logger.error("cyclic payload", cyclic as LogFields)).not.toThrow();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "error", msg: "cyclic payload", logError: "unserializable fields" });
  });

  it("keeps the message even when fields are dropped", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), now: () => 0 });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    logger.warn("still says what happened", cyclic as LogFields);
    expect(lines[0]).toContain("still says what happened");
  });
});
