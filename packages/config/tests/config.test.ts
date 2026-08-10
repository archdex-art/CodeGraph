import { describe, expect, it } from "vitest";
import { config, ConfigError, loadConfig } from "../src/index";

/**
 * These tests exist to prove two different things, and the distinction is the
 * whole point of the package:
 *
 *  - For every VALID environment, the resolved value equals what the v1 call
 *    site computed inline. P1 is structural; a working deployment must not
 *    notice this refactor. Each such test names the file it was read from.
 *  - For an INVALID environment, boot fails loudly and lists every problem.
 *    This IS a behaviour change, and a deliberate one: v1 silently substituted
 *    the default, so a typo in CG_MAX_FILES looked like it had been applied.
 */

const empty = {};

describe("defaults match the v1 call sites they replace", () => {
  it("dataDir defaults to <cwd>/data (lib/db.ts)", () => {
    expect(loadConfig(empty, { cwd: "/srv/app" }).dataDir).toBe("/srv/app/data");
  });

  it("dataDir honours CG_DATA_DIR when set", () => {
    expect(loadConfig({ CG_DATA_DIR: "/mnt/disk" }, { cwd: "/srv/app" }).dataDir).toBe("/mnt/disk");
  });

  it("maxFiles defaults to 4000 (lib/indexer.ts)", () => {
    expect(loadConfig(empty).maxFiles).toBe(4000);
  });

  it("cloneTimeoutMs defaults to 90_000 (lib/indexer.ts)", () => {
    expect(loadConfig(empty).cloneTimeoutMs).toBe(90_000);
  });

  it("trustedProxyHops defaults to 1 (lib/rateLimit.ts)", () => {
    expect(loadConfig(empty).trustedProxyHops).toBe(1);
  });

  it("basicAuthUser defaults to 'codegraph' (src/proxy.ts)", () => {
    expect(loadConfig(empty).basicAuthUser).toBe("codegraph");
  });

  it("leaves every optional credential undefined when unset", () => {
    // The app must boot with a completely empty environment — GitHub sign-in
    // is opt-in, and CG_SESSION_SECRET is validated lazily where a session is
    // actually encrypted, not at boot.
    const c = loadConfig(empty);
    expect(c.sessionSecret).toBeUndefined();
    expect(c.githubOauthClientId).toBeUndefined();
    expect(c.githubOauthClientSecret).toBeUndefined();
    expect(c.ownerGithubLogin).toBeUndefined();
    expect(c.publicAppUrl).toBeUndefined();
  });

  it("treats a whitespace-only value as absent", () => {
    // Real deployments produce these from templated YAML with an unfilled
    // placeholder. `CG_BASIC_AUTH_PASSWORD="   "` must not switch the auth gate
    // on with an unguessable-but-blank password.
    expect(loadConfig({ CG_BASIC_AUTH_PASSWORD: "   " }).basicAuthPassword).toBeUndefined();
    expect(loadConfig({ CG_DATA_DIR: "" }, { cwd: "/w" }).dataDir).toBe("/w/data");
  });
});

describe("allowLocalAccess keeps v1's tri-state semantics (lib/localAccess.ts)", () => {
  // The regression guarded here: LLD §10.3 sketches `.default(false)`, which
  // would silently disable local-folder indexing in development.
  it("is allowed by default outside production", () => {
    expect(loadConfig({ NODE_ENV: "development" }).allowLocalAccess).toBe(true);
    expect(loadConfig(empty).allowLocalAccess).toBe(true);
  });

  it("is denied by default in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).allowLocalAccess).toBe(false);
  });

  it("honours an explicit opt-in in production", () => {
    const c = loadConfig({ NODE_ENV: "production", CG_ALLOW_LOCAL_ACCESS: "true" });
    expect(c.allowLocalAccess).toBe(true);
  });

  it("honours an explicit opt-out in development", () => {
    const c = loadConfig({ NODE_ENV: "development", CG_ALLOW_LOCAL_ACCESS: "false" });
    expect(c.allowLocalAccess).toBe(false);
  });
});

describe("forceSecureCookies stays genuinely three-valued (lib/session.ts)", () => {
  it("is undefined when unset, in production as well as development", () => {
    // The regression this guards is a security one. Resolving "unset" to
    // `NODE_ENV === "production"` would make requestIsSecure() return true
    // without ever inspecting the transport, so a production deployment served
    // over plain HTTP behind a proxy would mark the session cookie `Secure`,
    // the browser would stop sending it, and sign-in would break. `undefined`
    // is what tells lib/session.ts to go and look at x-forwarded-proto.
    expect(loadConfig({ NODE_ENV: "production" }).forceSecureCookies).toBeUndefined();
    expect(loadConfig({ NODE_ENV: "development" }).forceSecureCookies).toBeUndefined();
  });

  it("can be forced either way", () => {
    expect(loadConfig({ NODE_ENV: "development", CG_FORCE_SECURE_COOKIES: "true" }).forceSecureCookies).toBe(true);
    expect(loadConfig({ NODE_ENV: "production", CG_FORCE_SECURE_COOKIES: "false" }).forceSecureCookies).toBe(false);
  });

  it("exposes isProduction separately for the no-request case", () => {
    // setSessionCookie()/oauthTransitCookieOptions() fall back to this when no
    // NextRequest is in scope, which is exactly what v1 did.
    expect(loadConfig({ NODE_ENV: "production" }).isProduction).toBe(true);
    expect(loadConfig({ NODE_ENV: "development" }).isProduction).toBe(false);
    expect(loadConfig({}).isProduction).toBe(false);
  });
});

describe("invalid values fail fast", () => {
  it("rejects a non-numeric integer instead of silently defaulting", () => {
    // v1: `Number(process.env.CG_MAX_FILES) || 4000` → NaN → 4000, no warning.
    // The operator believes a cap was applied. It was not.
    expect(() => loadConfig({ CG_MAX_FILES: "lots" })).toThrow(ConfigError);
  });

  it("rejects a fractional value where an integer is required", () => {
    expect(() => loadConfig({ CG_MAX_FILES: "40.5" })).toThrow(ConfigError);
  });

  it("rejects an out-of-range value", () => {
    expect(() => loadConfig({ CG_MAX_FILES: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ CG_TRUSTED_PROXY_HOPS: "-1" })).toThrow(ConfigError);
  });

  it("accepts trustedProxyHops=0, which disables proxy trust", () => {
    // Not an error: v1's guard was `isFinite(hops) && hops >= 1`, so 0 is a
    // meaningful, supported value and must not be rejected as out of range.
    expect(loadConfig({ CG_TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
  });

  it("rejects a boolean that is neither true nor false", () => {
    expect(() => loadConfig({ CG_ALLOW_LOCAL_ACCESS: "yes" })).toThrow(ConfigError);
  });

  it("accepts booleans case-insensitively", () => {
    expect(loadConfig({ CG_ALLOW_LOCAL_ACCESS: "TRUE" }).allowLocalAccess).toBe(true);
    expect(loadConfig({ CG_ALLOW_LOCAL_ACCESS: "False" }).allowLocalAccess).toBe(false);
  });

  it("reports EVERY problem in one throw, not just the first", () => {
    // The reason this matters: fixing a misconfigured deployment one failed
    // boot at a time is miserable, and it is why v1's scattered reads were
    // worth centralising in the first place.
    let error: unknown;
    try {
      loadConfig({ CG_MAX_FILES: "many", CG_TRUSTED_PROXY_HOPS: "nope", CG_ALLOW_LOCAL_ACCESS: "maybe" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const { problems, message } = error as ConfigError;
    expect(problems.map((p) => p.key).sort()).toEqual([
      "CG_ALLOW_LOCAL_ACCESS",
      "CG_MAX_FILES",
      "CG_TRUSTED_PROXY_HOPS",
    ]);
    // The message must name the offending variable AND what was expected —
    // an operator reading container logs has nothing else to go on.
    expect(message).toContain("CG_MAX_FILES");
    expect(message).toContain("an integer");
  });
});

describe("shape", () => {
  it("returns a frozen object", () => {
    // Configuration is read at boot; it is not a channel for passing runtime
    // state around.
    const c = loadConfig(empty);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("noColor follows the presence convention, not a value", () => {
    // https://no-color.org — any value, including empty, means "no colour".
    expect(loadConfig({ NO_COLOR: "" }).noColor).toBe(true);
    expect(loadConfig({ NO_COLOR: "0" }).noColor).toBe(true);
    expect(loadConfig(empty).noColor).toBe(false);
  });
});

describe("the exported `config` reads the environment live", () => {
  // Not a style preference — this is the behaviour v1 had, and seven test files
  // in apps/web depend on it, including the security regression tests for the
  // Secure cookie flag and for spoof-resistant rate-limit keying. Snapshotting
  // at import time broke 48 of them.
  it("observes a change made after import", () => {
    const original = process.env["CG_TRUSTED_PROXY_HOPS"];
    try {
      process.env["CG_TRUSTED_PROXY_HOPS"] = "3";
      expect(config.trustedProxyHops).toBe(3);
      process.env["CG_TRUSTED_PROXY_HOPS"] = "1";
      expect(config.trustedProxyHops).toBe(1);
      delete process.env["CG_TRUSTED_PROXY_HOPS"];
      expect(config.trustedProxyHops).toBe(1);
    } finally {
      if (original === undefined) delete process.env["CG_TRUSTED_PROXY_HOPS"];
      else process.env["CG_TRUSTED_PROXY_HOPS"] = original;
    }
  });

  it("is frozen, so a caller cannot overwrite a value for everyone else", () => {
    // Config is read, never written. Assigning through it would be a way to
    // smuggle per-request state into a process-wide object.
    const mutable = config as unknown as Record<string, unknown>;
    expect(() => {
      mutable["maxFiles"] = 1;
    }).toThrow(TypeError);
  });

  it("throws on an invalid value at access time rather than returning a default", () => {
    const original = process.env["CG_MAX_FILES"];
    try {
      process.env["CG_MAX_FILES"] = "not-a-number";
      expect(() => config.maxFiles).toThrow(ConfigError);
    } finally {
      if (original === undefined) delete process.env["CG_MAX_FILES"];
      else process.env["CG_MAX_FILES"] = original;
    }
  });
});

describe("execution topology defaults", () => {
  /**
   * `useWorker` is the one default that must track the PROCESS TOPOLOGY rather than a
   * preference: a queued job is claimed by `apps/worker`, the container starts that process
   * and `next dev` does not. Wrong in one direction, every dev index hangs forever waiting
   * for a claimant; wrong in the other, every unconfigured deployment runs a memory-bound
   * parse on the request path — the OOM ADR-001 exists to prevent.
   */
  it("routes through the worker in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).useWorker).toBe(true);
  });

  it("runs inline anywhere else, because nothing would claim the job", () => {
    expect(loadConfig({ NODE_ENV: "development" }).useWorker).toBe(false);
    expect(loadConfig({ NODE_ENV: "test" }).useWorker).toBe(false);
    expect(loadConfig(empty).useWorker).toBe(false);
  });

  it("lets either mode be chosen explicitly, whatever NODE_ENV says", () => {
    expect(loadConfig({ NODE_ENV: "production", CG_USE_WORKER: "false" }).useWorker).toBe(false);
    expect(loadConfig({ NODE_ENV: "development", CG_USE_WORKER: "true" }).useWorker).toBe(true);
  });

  it("bounds concurrent analysis on the host, in either mode", () => {
    expect(loadConfig(empty).maxConcurrentJobs).toBe(2);
    expect(loadConfig({ CG_MAX_CONCURRENT_JOBS: "4" }).maxConcurrentJobs).toBe(4);
    // A ceiling of zero would accept work and never run it.
    expect(() => loadConfig({ CG_MAX_CONCURRENT_JOBS: "0" })).toThrow(ConfigError);
  });

  it("bounds open progress streams globally and per client", () => {
    expect(loadConfig(empty).maxEventStreams).toBe(64);
    expect(loadConfig(empty).maxEventStreamsPerIp).toBe(8);
  });
});
