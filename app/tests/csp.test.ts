// Regression test for a real, live-breaking CSP bug: an earlier revision
// scoped the `cdn.jsdelivr.net` CSP allowance down to a path prefix
// (`/npm/monaco-editor/`) intended to trust only the one package this app
// needs (docs/AUDIT_2026-07-12.md F021), instead of jsdelivr's entire
// catalog. That silently broke the editor entirely: jsdelivr's package-URL
// convention glues the version directly onto the package name with no
// separating slash (`https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/
// vs/loader.js`), so the path-prefix `/npm/monaco-editor/` (which requires
// a literal `/` immediately after "monaco-editor") never matched the real
// request path. CSP violations are silent network blocks, not JS
// exceptions, so every file in the Editor got stuck on Monaco's own
// indefinite "Loading..." placeholder with no visible error at all.
//
// Reproduced live (real Chromium, real dev server, real CSP headers): the
// broken config left `.monaco-editor` never mounting; this fix restores it
// (verified `monacoLoaded === true`, zero CSP violations, in the same
// session).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Mirrors CSP's actual host-source path-prefix matching semantics (CSP3
// §6.7.2.4): a source ending in `/` matches iff the request path starts
// with that exact prefix, segment-boundary included.
function cspSourceAllows(source: string, requestUrl: string): boolean {
  if (!source.includes("/", "https://".length)) {
    // Origin-only source (no path component) — matches any path on that origin.
    const sourceOrigin = new URL(source).origin;
    return new URL(requestUrl).origin === sourceOrigin;
  }
  return requestUrl.startsWith(source);
}

describe("next.config.ts CSP — Monaco CDN trust boundary", () => {
  const src = readFileSync(path.join(__dirname, "..", "next.config.ts"), "utf8");
  const monacoCdnMatch = src.match(/const MONACO_CDN = "([^"]+)"/);
  const MONACO_CDN = monacoCdnMatch?.[1];

  it("MONACO_CDN constant is defined", () => {
    expect(MONACO_CDN).toBeTruthy();
  });

  it("never re-introduces the broken package-scoped path (docs/AUDIT_2026-07-12.md F021 regression)", () => {
    expect(MONACO_CDN).not.toBe("https://cdn.jsdelivr.net/npm/monaco-editor/");
  });

  it("actually allows the real URL @monaco-editor/loader's default config fetches (version glued to package name, no separating slash)", () => {
    const realMonacoLoaderUrl = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js";
    expect(cspSourceAllows(MONACO_CDN!, realMonacoLoaderUrl)).toBe(true);
  });

  it("the broken path-scoped form would NOT have allowed that same real URL (proves the regression was real, not hypothetical)", () => {
    const brokenSource = "https://cdn.jsdelivr.net/npm/monaco-editor/";
    const realMonacoLoaderUrl = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/loader.js";
    expect(cspSourceAllows(brokenSource, realMonacoLoaderUrl)).toBe(false);
  });

  it("script-src, style-src, font-src, and connect-src all reference the same MONACO_CDN constant (no directive left on the broken value)", () => {
    for (const directive of ["script-src", "style-src", "font-src", "connect-src"]) {
      const line = src.split("\n").find((l) => l.trim().startsWith("`" + directive));
      expect(line, `${directive} line`).toBeTruthy();
      expect(line).toContain("${MONACO_CDN}");
    }
  });
});
