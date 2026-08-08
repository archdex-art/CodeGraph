import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { loadConfig } from "@codegraph/config";
import { publicBaseUrl } from "@/lib/githubOAuth";

/**
 * Indexing signed out writes `owner_id IS NULL`, and `authz.ts` treats that bucket as
 * world-readable and world-mutable. Reads were never the bug — a signed-in owner's
 * repos are already private and the `VISIBLE` predicate is exhaustive and typed. What
 * was missing was the user being TOLD, so the answer is consent rather than a gate.
 */
describe("anonymous indexing", () => {
  it("is offered by default — blocking it removes the try-it-without-an-account path", () => {
    expect(loadConfig({ NODE_ENV: "production" }).allowAnonymousIndexing).toBe(true);
  });

  it("can still be forbidden outright by an operator", () => {
    expect(
      loadConfig({ NODE_ENV: "production", CG_ALLOW_ANONYMOUS_INDEXING: "false" })
        .allowAnonymousIndexing,
    ).toBe(false);
  });
});

/**
 * The OAuth redirect_uri must match the GitHub App registration exactly. The image sets
 * `HOSTNAME=0.0.0.0` (Render requires binding every interface) and Next's standalone
 * server builds `req.nextUrl` from it, so deriving the origin that way produced
 * `https://0.0.0.0:10000` and sent every visitor to GitHub's "redirect_uri is not
 * associated with this application" page. Deployment-wide, not per-user.
 */
describe("publicBaseUrl", () => {
  const req = (headers: Record<string, string>, url = "http://0.0.0.0:10000/api/auth/github") =>
    new NextRequest(new Request(url, { headers }));

  it("prefers the explicitly configured URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://codegraph.example.com";
    try {
      expect(publicBaseUrl(req({ host: "0.0.0.0:10000" }))).toBe("https://codegraph.example.com");
    } finally {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it("uses the proxy's forwarded host and scheme", () => {
    expect(
      publicBaseUrl(req({ "x-forwarded-host": "app.onrender.com", "x-forwarded-proto": "https" })),
    ).toBe("https://app.onrender.com");
  });

  it("takes only the first hop of a comma-joined forwarded chain", () => {
    expect(
      publicBaseUrl(
        req({ "x-forwarded-host": "app.onrender.com, inner", "x-forwarded-proto": "https, http" }),
      ),
    ).toBe("https://app.onrender.com");
  });

  it("falls back to the Host header when there is no proxy", () => {
    expect(publicBaseUrl(req({ host: "localhost:4000" }, "http://localhost:4000/x"))).toBe(
      "http://localhost:4000",
    );
  });

  /** The regression: a bind address is not somewhere a browser can be sent back to. */
  it("refuses a bind address rather than building an unmatchable redirect_uri", () => {
    for (const host of ["0.0.0.0:10000", "0.0.0.0", "::", "[::]"]) {
      expect(publicBaseUrl(req({ host }))).toBeNull();
    }
  });

  it("refuses when there is no host at all", () => {
    const bare = new NextRequest(new Request("http://0.0.0.0:10000/x"));
    bare.headers.delete("host");
    expect(publicBaseUrl(bare)).toBeNull();
  });
});
