import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox, detectTestRunner, hasTypeConfig } from "../src/index";

/**
 * The sandbox's job is bounded and it says so: a hard timeout with SIGKILL, no shell, cwd
 * pinned, environment scrubbed of tokens. Kernel isolation is NOT among them — `network: false`
 * is advisory. These tests cover what is actually enforced, because a test asserting the
 * advisory half would be claiming the same sandbox the docblock refuses to claim.
 */

const trees: string[] = [];
const tree = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "cg-sandbox-"));
  trees.push(d);
  return d;
};
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("createSandbox", () => {
  it("runs a command and captures stdout", async () => {
    const s = createSandbox({ root: tree() });
    const r = await s.exec("node", ["-e", "process.stdout.write('hi')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
  });

  it("pins cwd to the tree", async () => {
    const root = tree();
    const s = createSandbox({ root });
    const r = await s.exec("node", ["-e", "process.stdout.write(process.cwd())"]);
    // macOS reports /private/var for /var, so compare the resolved basename chain.
    expect(r.stdout.endsWith(path.basename(root))).toBe(true);
  });

  it("SIGKILLs a command that exceeds the timeout", async () => {
    // SIGKILL rather than SIGTERM on purpose: a runner that traps SIGTERM to print a summary
    // would sit inside the timeout it just exceeded.
    const s = createSandbox({ root: tree() });
    const r = await s.exec("node", ["-e", "setInterval(() => {}, 10)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it("uses no shell, so a crafted command name cannot inject", async () => {
    // `shell: false` means this is an argv element, not a command line. It must fail to spawn
    // rather than execute the `;`-separated payload.
    const s = createSandbox({ root: tree() });
    const r = await s.exec("node -e 'process.exit(7)'; echo pwned", []);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toMatch(/pwned/);
  });

  it("does not leak a CodeGraph secret into the child environment", async () => {
    // The environment is scrubbed because gate 3 runs ARBITRARY code from the analysed repo.
    process.env.CG_SESSION_SECRET = "super-secret-value";
    try {
      const s = createSandbox({ root: tree() });
      const r = await s.exec("node", [
        "-e",
        "process.stdout.write(JSON.stringify(process.env))",
      ]);
      expect(r.stdout).not.toMatch(/super-secret-value/);
    } finally {
      delete process.env.CG_SESSION_SECRET;
    }
  });

  it("returns a result rather than throwing when the binary is missing", async () => {
    // A missing runner is a normal outcome — the gate turns it into `skipped`, not a crash.
    const s = createSandbox({ root: tree() });
    const r = await s.exec("definitely-not-a-real-binary-xyz", []);
    expect(r.code).toBeNull();
  });
});

describe("detectTestRunner", () => {
  it("finds an npm test script", async () => {
    const root = tree();
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const r = await detectTestRunner(root);
    expect(r?.command).toBe("npm");
  });

  it("returns null when there is no test script, so the gate can skip honestly", async () => {
    const root = tree();
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(await detectTestRunner(root)).toBeNull();
  });

  it("returns null when there is no manifest at all", async () => {
    expect(await detectTestRunner(tree())).toBeNull();
  });

  it("does not crash on a malformed manifest", async () => {
    // A repository can contain anything, including invalid JSON.
    const root = tree();
    writeFileSync(path.join(root, "package.json"), "{ not json");
    expect(await detectTestRunner(root)).toBeNull();
  });
});

describe("hasTypeConfig", () => {
  it("is true only when a tsconfig.json exists", async () => {
    const root = tree();
    expect(await hasTypeConfig(root)).toBe(false);
    writeFileSync(path.join(root, "tsconfig.json"), "{}");
    expect(await hasTypeConfig(root)).toBe(true);
  });

  it("does not mistake a directory for the config", async () => {
    const root = tree();
    mkdirSync(path.join(root, "tsconfig.json"));
    // existsSync is true for a directory, so gate 2 would try to run tsc against nothing.
    expect(await hasTypeConfig(root)).toBe(false);
  });
});
