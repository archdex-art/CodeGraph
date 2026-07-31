import { describe, expect, it } from "vitest";
import { extractImports } from "../src/index";

/**
 * Import extraction must stay linear in line length.
 *
 * Prompted by CodeGraph's own `detect-unsafe-regex` finding during the precision audit
 * (`docs/design/PRECISION_PROTOCOL.md`), which scored 1/3 — and the one true positive was a
 * genuinely superlinear `IMPORT_RE`: 5.8ms at n=200, 141ms at n=800, **5,583ms at n=3200**.
 *
 * That regex turned out to be unreachable and was deleted with the dead extractor around it.
 * The live path is this module, and it is what needed the guard. Measured here at the time of
 * writing: flat to n=6400 for the JS/Go forms, quadratic-but-bounded for the Python `from`
 * form (29ms at n=6400), which is acceptable for a single line and is what this pins.
 *
 * A timing assertion is a blunt instrument, and the ceiling is set two orders of magnitude
 * above observed cost so that a slow machine does not fail it while a reintroduced ambiguity
 * still does.
 */
const adversarial: Array<[string, string]> = [
  ["js import/from", "import " + "a ".repeat(3000) + "from " + "!".repeat(8)],
  ["js require", "require(" + " ".repeat(3000) + "x".repeat(3000) + "!"],
  ["py from", " ".repeat(3000) + "from " + ".".repeat(3000) + " !"],
  ["py import", " ".repeat(3000) + "import " + "x".repeat(3000)],
  ["unterminated string", 'import x from "' + "y".repeat(6000)],
];

describe("import extraction under adversarial input", () => {
  it.each(adversarial)("%s stays fast", (_label, line) => {
    const t0 = Date.now();
    extractImports(line, ".ts");
    extractImports(line, ".py");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("still extracts every ordinary form", () => {
    // A speed guard is worthless if it is met by extracting nothing.
    // Only RELATIVE specifiers: this builds a file-level graph, and a bare package name does
    // not resolve to a file in the repository (line 74).
    const ts = extractImports('import { a } from "./m";\nimport d from "pkg";\n', ".ts");
    expect(ts).toContain("./m");
    expect(ts).not.toContain("pkg");
    const py = extractImports("from .rel import thing\nimport os\n", ".py");
    expect(py.length).toBeGreaterThan(0);
  });
});
