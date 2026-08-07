import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeReturnPath } from "@codegraph/vcs";

/**
 * `returnTo` survives the OAuth round trip in a cookie, and the callback resolves it with
 * `new URL(returnTo, base)` — which honours an ABSOLUTE url. Validation existed only where
 * the cookie was WRITTEN, which covers values this app produced and nothing else: a cookie
 * is client-side state, so a sibling subdomain or any script that can set it chose the
 * post-sign-in destination, with the session cookie already attached.
 */
describe("isSafeReturnPath", () => {
  it("accepts an ordinary in-app path", () => {
    expect(isSafeReturnPath("/")).toBe(true);
    expect(isSafeReturnPath("/repos/abc/network")).toBe(true);
  });

  it("rejects anything that can leave the origin", () => {
    expect(isSafeReturnPath("https://evil.com/")).toBe(false);
    expect(isSafeReturnPath("//evil.com")).toBe(false);
    expect(isSafeReturnPath("/\\evil.com")).toBe(false);
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false);
  });

  it("is what an absolute url would otherwise do to the redirect", () => {
    // The behaviour being guarded against, stated explicitly.
    expect(new URL("https://evil.com/", "http://localhost:3000").origin).toBe("https://evil.com");
    expect(new URL("/repos/abc", "http://localhost:3000").origin).toBe("http://localhost:3000");
  });
});

describe("both ends of the OAuth round trip validate returnTo", () => {
  // Structural: the bug was an unvalidated READ of a value validated at write time, so what
  // must hold is that neither end trusts the other.
  it.each([
    "src/app/api/auth/github/route.ts",
    "src/app/api/auth/github/callback/route.ts",
  ])("%s calls isSafeReturnPath", (rel) => {
    const source = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    expect(source).toContain("isSafeReturnPath(");
  });
});
