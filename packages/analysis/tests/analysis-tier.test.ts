import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * The degradation ladder (HLD §8.3), which existed only in the design document.
 *
 * Nothing recorded a tier per file, nothing published coverage by tier, and the promise that
 * `lexical` findings are "marked low-confidence" was kept nowhere in the code. A regex hit in a
 * file nobody parsed might sit in a comment, a string, or running code - the distinction the
 * context gate draws for TypeScript and cannot draw for Python.
 */
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function index(files: Record<string, string>) {
  dir = mkdtempSync(path.join(tmpdir(), "cg-tier-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return indexRepo(dir);
}

describe("analysis tier", () => {
  it("marks a finding from an unparsed file lower than the same finding from a parsed one", () => {
    // The claim HLD §8.3 makes, asserted as a comparison rather than a magic number so it
    // survives any retuning of the factor.
    return (async () => {
      const r = await index({
        "a.ts": "export function f() { console.log('x'); }\n",
        "b.py": "def f():\n    print('x')\n",
      });
      const ts = r.issues.find((i) => i.file.endsWith("a.ts") && i.title === "Leftover debug output");
      const py = r.issues.find((i) => i.file.endsWith("b.py") && i.title === "Leftover debug output");
      expect(ts?.confidence).toBeDefined();
      expect(py?.confidence).toBeDefined();
      expect(py!.confidence!).toBeLessThan(ts!.confidence!);
    })();
  });

  it("scales confidence proportionally rather than collapsing it to a floor", async () => {
    /**
     * Downgrade, never delete: hiding these trades visible noise for silent blindness on every
     * non-TypeScript file in the repository.
     *
     * Asserted as a RATIO between two rules with different base confidence, which pins
     * proportionality without hard-coding the factor. An earlier version asserted only
     * `confidence > 0` - and `scaleConfidence` has a 0.05 floor, so it passed even with the
     * factor set to zero. Mutation testing caught that the assertion could not fail.
     */
    const r = await index({
      "b.py": "import subprocess\n\n\ndef f():\n    print('x')\n    subprocess.run(['ls'])\n",
    });
    const debug = r.issues.find((i) => i.title === "Leftover debug output");
    const shell = r.issues.find((i) => i.title === "Shell/process execution");
    expect(debug?.confidence).toBeDefined();
    expect(shell?.confidence).toBeDefined();
    // Base confidences are 1.0 and 0.85; the gap must survive the downgrade.
    expect(debug!.confidence!).toBeGreaterThan(shell!.confidence!);
    expect(debug!.confidence! / shell!.confidence!).toBeCloseTo(1 / 0.85, 2);
  });

  it("reports LOC by tier so coverage can be published", async () => {
    const r = await index({
      "a.ts": "export const x = 1;\nexport const y = 2;\n",
      "b.py": "x = 1\n",
    });
    expect(r.coverage?.tierLoc?.full).toBeGreaterThan(0);
    expect(r.coverage?.tierLoc?.lexical).toBeGreaterThan(0);
  });

  it("counts a TypeScript-family file as full tier, not lexical", async () => {
    const r = await index({ "a.tsx": "export const A = () => null;\n" });
    expect(r.coverage?.tierLoc?.lexical ?? 0).toBe(0);
    expect(r.coverage?.tierLoc?.full).toBeGreaterThan(0);
  });
});
