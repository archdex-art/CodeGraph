import { describe, expect, it } from "vitest";
import { extractorFor } from "../src/index";

/**
 * CommonJS exports were invisible to the extractor, and a call cannot resolve to a symbol that
 * was never extracted. Measured on `expressjs/express@a371447`, CommonJS throughout:
 *
 *   symbols  123 -> 174      resolved call edges  11 -> 37
 *
 * The graph is the product (IDENTITY.md §1), so an extractor that cannot see a whole module
 * system is not a detection detail — it is the product being blind on that codebase.
 */
const extract = (text: string) =>
  extractorFor(".js")!.extract({ text, relPath: "lib/app.js" } as never).symbols;

describe("CommonJS export extraction", () => {
  it.each([
    ["exports.init = function init(a) { return a; };", "init", "function"],
    ["exports.handle = function (r) { return r; };", "handle", "function"],
    ["module.exports.render = function render(v) { return v; };", "render", "function"],
    ["exports.arrow = (x) => x + 1;", "arrow", "function"],
    ["exports.VERSION = '1.0';", "VERSION", "constant"],
    ["exports.Thing = class { m() {} };", "Thing", "class"],
  ])("extracts %s", (src, name, kind) => {
    const s = extract(src).find((x) => x.name === name);
    expect(s, `expected a symbol named ${name}`).toBeDefined();
    expect(s!.kind).toBe(kind);
    expect(s!.exported).toBe(true);
  });

  it("does not treat an export inside a comment or string as a definition", () => {
    // The reason this is matched on the AST rather than by regex.
    const s = extract(
      '// exports.fake = function(){}\nconst t = "exports.alsoFake = function(){}";\n',
    );
    expect(s.map((x) => x.name)).not.toContain("fake");
    expect(s.map((x) => x.name)).not.toContain("alsoFake");
  });

  it("still extracts ES declarations alongside", () => {
    const names = extract("export function a() {}\nexports.b = function () {};\n").map((s) => s.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("ignores assignments to things that are not exports", () => {
    const names = extract("foo.bar = function () {};\nthis.baz = function () {};\n").map((s) => s.name);
    expect(names).not.toContain("bar");
    expect(names).not.toContain("baz");
  });
});
