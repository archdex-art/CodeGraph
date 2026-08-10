import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRecord,
  reanalysisGate,
  syntaxGate,
  testsGate,
  typesGate,
  type ExecResult,
  type FixCandidate,
  type SandboxHandle,
} from "../src/index";

/**
 * The four gates individually (LLD §7.2).
 *
 * `sandbox.exec` is a stub here because what each gate DECIDES from an exit code is the
 * behaviour under test, not whether `spawn` works — that is covered where it belongs, in
 * `apps/worker`. The gates are given a real temp tree so file reads are real.
 */

// `fsReadFile` is overloaded and its bare form returns Buffer; the gate's contract is
// `(path) => Promise<string>`, so the encoding is pinned here rather than widening the
// gate's signature to accept Buffers it would then have to decode.
const readFile = (p: string): Promise<string> => fsReadFile(p, "utf8");

const dirs: string[] = [];

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-verify-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox(root: string, results: Record<string, ExecResult>): SandboxHandle {
  return {
    root,
    exec: async (command) =>
      results[command] ?? { code: 0, stdout: "", stderr: "", timedOut: false },
  };
}

const ok: ExecResult = { code: 0, stdout: "ok", stderr: "", timedOut: false };
const fail: ExecResult = { code: 1, stdout: "", stderr: "boom", timedOut: false };
const hung: ExecResult = { code: null, stdout: "", stderr: "", timedOut: true };

function candidate(files: string[]): FixCandidate {
  return {
    findingId: "f1" as FixCandidate["findingId"],
    providerId: "p1",
    edits: files.map((file) => ({
      range: { file, startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
      newText: "",
    })),
    explanation: "test",
    confidence: 1,
  };
}

describe("gate 1 — syntax", () => {
  const parses = () => ({ ok: true });
  const broken = () => ({ ok: false, error: "Unexpected token" });

  it("passes when every edited file re-parses", async () => {
    const root = tree({ "a.ts": "export const a = 1;" });
    const r = await syntaxGate(candidate(["a.ts"]), sandbox(root, {}), parses, readFile);
    expect(r.status).toBe("passed");
  });

  it("fails and names the file when one does not", async () => {
    const root = tree({ "a.ts": "export const a = ", "b.ts": "export const b = 1;" });
    const r = await syntaxGate(candidate(["b.ts", "a.ts"]), sandbox(root, {}), broken, readFile);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/b\.ts|a\.ts/);
  });

  it("fails rather than throws when an edited file cannot be read", async () => {
    // A fix that reports editing a file it did not create is a real failure mode, and it
    // must not take the whole record down with an exception.
    const root = tree({});
    const r = await syntaxGate(candidate(["missing.ts"]), sandbox(root, {}), parses, readFile);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/could not read/);
  });
});

describe("gate 2 — types", () => {
  // The compiler is injected as an absolute argv pair the analysed repository cannot choose.
  // `node` here stands for `process.execPath`; the stub keys on the command name.
  const tsc = () => ({ command: "node", args: ["/trusted/tsc"] as readonly string[] });

  it("skips when the project has no type config", async () => {
    // Most JavaScript repos have none. Failing them would make every such fix unverifiable.
    const r = await typesGate(sandbox(tree({}), {}), async () => false, tsc);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/no tsconfig/);
  });

  it("passes when tsc exits 0", async () => {
    const r = await typesGate(sandbox(tree({}), { node: ok }), async () => true, tsc);
    expect(r.status).toBe("passed");
  });

  it("fails when tsc reports errors, keeping the output", async () => {
    const r = await typesGate(sandbox(tree({}), { node: fail }), async () => true, tsc);
    expect(r.status).toBe("failed");
    expect(r.log).toContain("boom");
  });

  it("treats a timeout as a failure, not a skip", async () => {
    // The check did not complete. Skipping would let a pathological project quietly
    // downgrade its own verification level.
    const r = await typesGate(sandbox(tree({}), { node: hung }), async () => true, tsc);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/timed out/);
  });

  it("never invokes a compiler resolved from the analysed tree", async () => {
    /**
     * The RCE this gate shipped with: `sandbox.exec("npx", ["tsc", "--noEmit"])` with cwd set
     * to a freshly cloned, attacker-controlled repository. `npx` prefers
     * `./node_modules/.bin/tsc`, which a repository can commit mode 100755, so an anonymous
     * caller who could get a repo indexed could execute code in the web process.
     *
     * Asserting on the argv is the assertion that matters: any command that is not the
     * injected absolute one is a path the repository can influence.
     */
    const seen: string[][] = [];
    const handle: SandboxHandle = {
      root: tree({}),
      exec: async (command, args) => {
        seen.push([command, ...args]);
        return ok;
      },
    };
    await typesGate(handle, async () => true, tsc);
    expect(seen).toEqual([["node", "/trusted/tsc", "--noEmit"]]);
    expect(seen.flat()).not.toContain("npx");
  });

  it("skips rather than falling back when this runtime has no compiler", async () => {
    // "We could not check" is a true statement about the verification. Reaching for the
    // repository's own binary to avoid saying it is the trade that created the RCE.
    const r = await typesGate(sandbox(tree({}), { node: ok }), async () => true, () => null);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/no TypeScript compiler/);
  });
});

describe("gate 3 — tests", () => {
  const runner = async () => ({ command: "npm", args: ["test"] as readonly string[] });

  it("skips when test verification is not enabled", async () => {
    // Running a repo's suite executes arbitrary code FROM that repo, so it is opt-in.
    const r = await testsGate(sandbox(tree({}), {}), {
      allowed: false,
      canIsolate: true,
      detectRunner: runner,
    });
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/CG_ALLOW_TEST_VERIFICATION/);
  });

  it("skips when the host cannot isolate, citing the constraint", async () => {
    // SPIKES §2: Render grants no privileged containers, so the hosted demo reports partial.
    const r = await testsGate(sandbox(tree({}), {}), {
      allowed: true,
      canIsolate: false,
      detectRunner: runner,
    });
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/SPIKES/);
  });

  it("skips when the manifest has no test script", async () => {
    const r = await testsGate(sandbox(tree({}), {}), {
      allowed: true,
      canIsolate: true,
      detectRunner: async () => null,
    });
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/no test script/);
  });

  it("CATCHES A DELIBERATELY BROKEN FIX — PLAN.md §4's exit criterion", async () => {
    // The whole phase exists for this: a fix that breaks the repository must not be
    // reported as verified. The suite fails, so the gate fails, so the record is not
    // verified — regardless of what happened to the aggregate score, which is what the
    // shipped implementation graded on.
    const r = await testsGate(sandbox(tree({}), { npm: fail }), {
      allowed: true,
      canIsolate: true,
      detectRunner: runner,
    });
    expect(r.status).toBe("failed");

    const record = buildRecord("c1", [
      { gate: "syntax", status: "passed", ms: 1 },
      { gate: "reanalysis", status: "passed", ms: 1 },
      r,
    ]);
    expect(record.verified).toBe(false);
    expect(record.level).toBe("none");
  });

  it("fails a suite that exceeds its timeout", async () => {
    const r = await testsGate(sandbox(tree({}), { npm: hung }), {
      allowed: true,
      canIsolate: true,
      detectRunner: runner,
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/timeout/);
  });
});

describe("gate 4 — reanalysis", () => {
  const before = new Set(["target-fp", "other-fp"]);

  it("passes when the target fingerprint is gone and nothing new appeared", async () => {
    const r = await reanalysisGate(candidate(["a.ts"]), before, "target-fp", async () =>
      new Set(["other-fp"])
    );
    expect(r.status).toBe("passed");
  });

  it("FAILS when the target fingerprint is still present", async () => {
    // This is the case the shipped check cannot see. An unrelated improvement in the same
    // re-index keeps the aggregate score up, so `after.score >= before.score` passes while
    // the finding the fix claimed to address is still sitting there.
    const r = await reanalysisGate(candidate(["a.ts"]), before, "target-fp", async () =>
      new Set(["target-fp", "other-fp"])
    );
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/still present/);
  });

  it("fails when the fix removed its target but introduced something new", async () => {
    // Not optional. Trading one finding for another has not earned "verified", even though
    // the finding it was asked about is gone.
    const r = await reanalysisGate(candidate(["a.ts"]), before, "target-fp", async () =>
      new Set(["other-fp", "brand-new-fp"])
    );
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/introduced 1 new finding/);
  });

  it("does not count pre-existing findings as newly introduced", async () => {
    const r = await reanalysisGate(candidate(["a.ts"]), before, "target-fp", async () =>
      new Set(["other-fp"])
    );
    expect(r.status).toBe("passed");
  });

  it("verifies only the no-new-findings half when no target is named", async () => {
    // The batch path: `executeFixes` cannot attribute an edit to the finding it served, so
    // there is no specific claim to check. Passing null says that, instead of inventing a
    // target — which an earlier version did, and it failed a fix that had worked perfectly
    // because the invented target was a finding no provider handles.
    const r = await reanalysisGate(candidate(["a.ts"]), before, null, async () =>
      new Set(["target-fp", "other-fp"])
    );
    expect(r.status).toBe("passed");
    // And the reason must not let a reader infer the stronger claim.
    expect(r.reason).toMatch(/does not prove a specific finding was fixed/);
  });

  it("still fails on newly-introduced findings when no target is named", async () => {
    // The half it CAN check is not weakened by the missing target.
    const r = await reanalysisGate(candidate(["a.ts"]), before, null, async () =>
      new Set(["other-fp", "new-fp"])
    );
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/introduced 1 new finding/);
  });
});
