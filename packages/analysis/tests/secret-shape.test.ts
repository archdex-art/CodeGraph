import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * "Possible hardcoded secret" weighted by whether the VALUE looks machine-generated.
 *
 * Found by running CodeGraph on CodeGraph: this rule dominated the top of our own findings and
 * drove the security dimension to 12, and every instance was wrong. Two classes, both real:
 *
 *   apps/web/src/lib/settings.ts   anthropicApiKey: "assistant.anthropicApiKey"   (a settings PATH)
 *   apps/web/tests/redact.test.ts  anthropicApiKey: "sk-ant-BAD-KEY"              (a test fixture)
 *
 * Entropy was tried and rejected: the fixture `sk-ant-SCOPED-BUT-VALID-KEY` scores H=4.18,
 * ABOVE `AKIAIOSFODNN7EXAMPLE` (3.68) and a 40-char hex digest (3.83).
 */
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function confidenceOf(src: string): Promise<number | undefined> {
  dir = mkdtempSync(path.join(tmpdir(), "cg-secret-"));
  writeFileSync(path.join(dir, "a.ts"), src);
  const r = await indexRepo(dir);
  return r.issues.find((i) => i.title === "Possible hardcoded secret")?.confidence;
}

describe("hardcoded secret value shape", () => {
  it("keeps full confidence for a credential-shaped value", async () => {
    const strong = await confidenceOf('export const k = { apiKey: "sk-ant-api03-x7Kd9mQ2pL4vR8nT1wY6zA3bC5eF" };\n');
    expect(strong).toBeDefined();
    expect(strong!).toBeGreaterThan(0.5);
  });

  it("downgrades a dotted config path", async () => {
    // The real finding: `anthropicApiKey: "assistant.anthropicApiKey"` names a settings key.
    const weak = await confidenceOf('export const K = { apiKey: "assistant.anthropicApiKey" };\n');
    const strong = await confidenceOf('export const k = { apiKey: "sk-ant-api03-x7Kd9mQ2pL4vR8nT1wY6zA3bC5eF" };\n');
    expect(weak).toBeDefined();
    expect(weak!).toBeLessThan(strong!);
  });

  it("downgrades an all-letter test fixture", async () => {
    const weak = await confidenceOf('export const t = { apiKey: "sk-ant-SCOPED-BUT-VALID-KEY" };\n');
    expect(weak).toBeDefined();
    expect(weak!).toBeLessThan(0.5);
  });

  it("downgrades a LONG config path, which the digit rule alone would let through", async () => {
    /**
     * `CONFIG_PATH_RE` earns its place only here. `assistant.anthropicApiKey` is already
     * rejected for having no digits, so removing the path check changed nothing and mutation
     * testing reported it as dead. It is not: a dotted path that is 32+ characters, or that
     * contains a digit, passes the digit/length test and needs the shape check to catch it.
     */
    const longPath = await confidenceOf(
      'export const K = { apiKey: "services.auth.tokenEndpointOverrideKey" };\n',
    );
    const digitPath = await confidenceOf('export const K = { apiKey: "assistant.model2ApiKey" };\n');
    expect(longPath).toBeDefined();
    expect(digitPath).toBeDefined();
    expect(longPath!).toBeLessThan(0.5);
    expect(digitPath!).toBeLessThan(0.5);
  });

  it("does NOT delete a downgraded finding", async () => {
    // `correcthorsebatterystaple` is a real secret with no digits in it. The signal is weak
    // evidence about the value, not proof it is harmless.
    const weak = await confidenceOf('export const t = { password: "correcthorsebatterystaple" };\n');
    const strong = await confidenceOf('export const k = { apiKey: "sk-ant-api03-x7Kd9mQ2pL4vR8nT1wY6zA3bC5eF" };\n');
    expect(weak).toBeDefined();
    /**
     * Relative to the undiscounted case, not `> 0`. `scaleConfidence` floors at 0.05, so a
     * literal `> 0` passes even with the factor set to ZERO - the finding would be effectively
     * erased and the assertion would not notice. Mutation testing caught exactly that.
     */
    expect(weak!).toBeGreaterThan(strong! * 0.1);
  });

  it("keeps a long value even without digits", async () => {
    /**
     * 32+ characters is long enough that a generated secret is plausible on length alone.
     *
     * The fixture was originally `abcdefghijklmnopqrstuvwxyz...`, which the later synthetic-run
     * check correctly began suppressing — the alphabet is not what a generator emits. The rule
     * was right and the fixture was unrealistic; replaced with a value that looks generated.
     */
    const long = await confidenceOf(
      'export const t = { secret: "xKfmQpLvRnTwYzAbCdEfGhJkMnPqRsTuVw" };\n',
    );
    expect(long).toBeDefined();
    expect(long!).toBeGreaterThan(0.5);
  });
});

describe("placeholder suppression (precision audit follow-up)", () => {
  /**
   * "Possible hardcoded secret" scored **0/8** in the audit — every match a fixture or a
   * documentation placeholder. These are the measured values, verbatim.
   */
  const suppressed = [
    ['apiKey: "sk-test-key"', "sk-test-key"],
    ['secret: "test-secret-for-fleet-graph"', "test-secret-for-fleet-graph"],
    ['token: "ghp_0123456789abcdefghijABCDEFGHIJ"', "sequential run"],
    ['password: "foobar"', "foobar"],
    ['accessToken: "unused"', "unused"],
  ] as const;

  it.each(suppressed)("suppresses %s", async (expr) => {
    expect(await confidenceOf(`export const k = { ${expr} };\n`)).toBeUndefined();
  });

  it("still reports a credential-shaped value", async () => {
    // The guard against a fix that silences the rule rather than narrowing it.
    const c = await confidenceOf('export const k = { apiKey: "sk-ant-api03-x7Kd9mQ2pL4vR8nT1wY6zA3bC5eF" };\n');
    expect(c).toBeDefined();
    expect(c!).toBeGreaterThan(0.5);
  });

  it("does not suppress on a coincidental substring", async () => {
    // `AKIAIOSFODNN7EXAMPLE` contains "EXAMPLE" but preceded by `7`, so it is not a token.
    // Without the boundary requirement this real-shaped value would vanish.
    expect(await confidenceOf('export const k = { apiKey: "AKIAIOSFODNN7EXAMPLE" };\n')).toBeDefined();
  });
});
