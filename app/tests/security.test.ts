import { afterEach, describe, expect, it } from "vitest";
import { localAccessAllowed, LOCAL_ACCESS_DISABLED_MESSAGE } from "@/lib/localAccess";
import { isPublicHttpUrl } from "@/lib/urlSafety";
import { checkBasicAuth } from "@/lib/basicAuth";
import { isAllowedOwnerLogin, ownerLoginAllowlist } from "@/lib/githubOAuth";

// Snapshot the real env once, before any test mutates it, so every test can
// freely stomp on CG_ALLOW_LOCAL_ACCESS / NODE_ENV and afterEach puts things
// back exactly as they were — no leakage into other test files or between
// runs of this file. Cast through a plain index-signature type because
// @types/node (via Next.js's global augmentation) declares `NODE_ENV` as
// readonly on the real `ProcessEnv` interface, specifically to stop app
// code from casually reassigning it — tests deliberately need to.
const env = process.env as Record<string, string | undefined>;
const ORIGINAL_ALLOW_LOCAL_ACCESS = env.CG_ALLOW_LOCAL_ACCESS;
const ORIGINAL_NODE_ENV = env.NODE_ENV;

function restoreEnv(): void {
  if (ORIGINAL_ALLOW_LOCAL_ACCESS === undefined) delete env.CG_ALLOW_LOCAL_ACCESS;
  else env.CG_ALLOW_LOCAL_ACCESS = ORIGINAL_ALLOW_LOCAL_ACCESS;
  if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = ORIGINAL_NODE_ENV;
}

describe("localAccessAllowed", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("is allowed when CG_ALLOW_LOCAL_ACCESS=true, even in production", () => {
    env.CG_ALLOW_LOCAL_ACCESS = "true";
    env.NODE_ENV = "production";
    expect(localAccessAllowed()).toBe(true);
  });

  it("is allowed when CG_ALLOW_LOCAL_ACCESS=true outside production", () => {
    env.CG_ALLOW_LOCAL_ACCESS = "true";
    env.NODE_ENV = "development";
    expect(localAccessAllowed()).toBe(true);
  });

  it("is disallowed when CG_ALLOW_LOCAL_ACCESS=false, even outside production", () => {
    env.CG_ALLOW_LOCAL_ACCESS = "false";
    env.NODE_ENV = "development";
    expect(localAccessAllowed()).toBe(false);
  });

  it("is disallowed when CG_ALLOW_LOCAL_ACCESS=false in production", () => {
    env.CG_ALLOW_LOCAL_ACCESS = "false";
    env.NODE_ENV = "production";
    expect(localAccessAllowed()).toBe(false);
  });

  it("defaults to disallowed in production when CG_ALLOW_LOCAL_ACCESS is unset", () => {
    delete env.CG_ALLOW_LOCAL_ACCESS;
    env.NODE_ENV = "production";
    expect(localAccessAllowed()).toBe(false);
  });

  it("defaults to allowed outside production when CG_ALLOW_LOCAL_ACCESS is unset", () => {
    delete env.CG_ALLOW_LOCAL_ACCESS;
    env.NODE_ENV = "development";
    expect(localAccessAllowed()).toBe(true);
  });

  it("defaults to allowed when both CG_ALLOW_LOCAL_ACCESS and NODE_ENV are unset", () => {
    delete env.CG_ALLOW_LOCAL_ACCESS;
    delete env.NODE_ENV;
    expect(localAccessAllowed()).toBe(true);
  });

  it("exposes a non-empty, human-readable disabled message", () => {
    expect(typeof LOCAL_ACCESS_DISABLED_MESSAGE).toBe("string");
    expect(LOCAL_ACCESS_DISABLED_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("isPublicHttpUrl", () => {
  const PUBLIC_URLS = [
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "https://gitlab.com/owner/repo.git",
    "http://bitbucket.org/owner/repo",
    "https://git.example.com/owner/repo.git",
    "https://git.example.com:8443/owner/repo.git",
    // IPv4 that merely resembles a private range but falls outside it.
    "http://172.15.0.1/repo",
    "http://172.32.0.1/repo",
    // A real public IPv6 address (Google public DNS).
    "http://[2001:4860:4860::8888]/repo",
  ];

  it.each(PUBLIC_URLS)("accepts public URL %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(true);
  });

  const PRIVATE_IPV4_URLS = [
    "http://127.0.0.1/repo",
    "http://127.5.6.7/repo",
    "http://10.0.0.5/repo",
    "http://10.255.255.255/repo",
    "http://172.16.0.1/repo",
    "http://172.31.255.255/repo",
    "http://192.168.1.1/repo",
    "http://192.168.0.100/repo",
    "http://169.254.169.254/repo", // cloud metadata endpoint
    "http://0.0.0.0/repo",
  ];

  it.each(PRIVATE_IPV4_URLS)("rejects private/loopback/link-local IPv4 URL %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  const PRIVATE_IPV6_URLS = [
    "http://[::1]/repo", // loopback
    "http://[fc00::1]/repo", // unique local (fc00::/7)
    "http://[fd12:3456::1]/repo", // unique local (fc00::/7, fd half)
    "http://[fe80::1]/repo", // link-local
  ];

  it.each(PRIVATE_IPV6_URLS)("rejects private/loopback/link-local IPv6 URL %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  const LOCALHOST_URLS = [
    "http://localhost/repo",
    "http://localhost:3000/repo",
    "https://localhost/repo",
    "http://foo.localhost/repo",
    "http://myapp.local/repo",
    "http://server.local:8080/repo",
  ];

  it.each(LOCALHOST_URLS)("rejects localhost-style hostname %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  const NON_HTTP_URLS = [
    "ftp://example.com/repo",
    "file:///etc/passwd",
    "git://github.com/owner/repo",
    "ssh://git@github.com/owner/repo.git",
  ];

  it.each(NON_HTTP_URLS)("rejects non-http(s) protocol %s", (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  const MALFORMED_URLS = ["not a url", "", "http://", "http://256.1.2.3/repo", "   "];

  it.each(MALFORMED_URLS)("rejects malformed URL %j", (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });
});

describe("checkBasicAuth", () => {
  const USER = "admin";
  const PASSWORD = "s3cret";

  function basicHeader(user: string, password: string): string {
    return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  }

  it("rejects a null header", () => {
    expect(checkBasicAuth(null, USER, PASSWORD)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(checkBasicAuth("", USER, PASSWORD)).toBe(false);
  });

  it("rejects a header without the Basic scheme prefix", () => {
    const bearer = "Bearer " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
    expect(checkBasicAuth(bearer, USER, PASSWORD)).toBe(false);
  });

  it("rejects malformed base64 payloads without throwing", () => {
    expect(() => checkBasicAuth("Basic not-valid-base64!!!", USER, PASSWORD)).not.toThrow();
    expect(checkBasicAuth("Basic not-valid-base64!!!", USER, PASSWORD)).toBe(false);
  });

  it("accepts correctly encoded matching credentials", () => {
    expect(checkBasicAuth(basicHeader(USER, PASSWORD), USER, PASSWORD)).toBe(true);
  });

  it("rejects a wrong username with the correct password", () => {
    expect(checkBasicAuth(basicHeader("intruder", PASSWORD), USER, PASSWORD)).toBe(false);
  });

  it("rejects the correct username with a wrong password", () => {
    expect(checkBasicAuth(basicHeader(USER, "wrong-password"), USER, PASSWORD)).toBe(false);
  });

  it("splits only on the first colon, so a password containing a colon still matches", () => {
    const passwordWithColon = "pa:ss:word";
    const header = basicHeader(USER, passwordWithColon);
    expect(checkBasicAuth(header, USER, passwordWithColon)).toBe(true);
    // A truncated expectation (split on every colon) must NOT match.
    expect(checkBasicAuth(header, USER, "pa")).toBe(false);
  });
});

describe("ownerLoginAllowlist / isAllowedOwnerLogin", () => {
  const ORIGINAL_OWNER_LOGIN = env.CG_OWNER_GITHUB_LOGIN;
  afterEach(() => {
    if (ORIGINAL_OWNER_LOGIN === undefined) delete env.CG_OWNER_GITHUB_LOGIN;
    else env.CG_OWNER_GITHUB_LOGIN = ORIGINAL_OWNER_LOGIN;
  });

  it("returns null (owner-lock off) when CG_OWNER_GITHUB_LOGIN is unset", () => {
    delete env.CG_OWNER_GITHUB_LOGIN;
    expect(ownerLoginAllowlist()).toBeNull();
  });

  it("returns null for a blank/whitespace-only value", () => {
    env.CG_OWNER_GITHUB_LOGIN = "   ";
    expect(ownerLoginAllowlist()).toBeNull();
  });

  it("parses a single login into a one-element lowercased list", () => {
    env.CG_OWNER_GITHUB_LOGIN = "SomeUser";
    expect(ownerLoginAllowlist()).toEqual(["someuser"]);
  });

  it("parses a comma-separated list, trimming whitespace and lowercasing", () => {
    env.CG_OWNER_GITHUB_LOGIN = " Alice ,BOB, carol ";
    expect(ownerLoginAllowlist()).toEqual(["alice", "bob", "carol"]);
  });

  it("isAllowedOwnerLogin defaults to true (no restriction) when owner-lock is off", () => {
    delete env.CG_OWNER_GITHUB_LOGIN;
    expect(isAllowedOwnerLogin("anyone")).toBe(true);
  });

  it("isAllowedOwnerLogin matches case-insensitively against the allowlist", () => {
    env.CG_OWNER_GITHUB_LOGIN = "octocat";
    expect(isAllowedOwnerLogin("OctoCat")).toBe(true);
    expect(isAllowedOwnerLogin("octocat")).toBe(true);
  });

  it("isAllowedOwnerLogin rejects a login not on the allowlist", () => {
    env.CG_OWNER_GITHUB_LOGIN = "octocat";
    expect(isAllowedOwnerLogin("intruder")).toBe(false);
  });

  it("isAllowedOwnerLogin supports a multi-login allowlist", () => {
    env.CG_OWNER_GITHUB_LOGIN = "alice,bob";
    expect(isAllowedOwnerLogin("alice")).toBe(true);
    expect(isAllowedOwnerLogin("bob")).toBe(true);
    expect(isAllowedOwnerLogin("carol")).toBe(false);
  });
});
