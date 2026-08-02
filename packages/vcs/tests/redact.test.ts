import { describe, expect, it } from "vitest";
import { redactCredentials, redactError } from "../src/index";

/**
 * F004/F017. `git` embeds the access token directly in the remote URL and echoes
 * it back in its own error output, so anything forwarding that verbatim — a log
 * line, a stored job error, an API response — leaks a live credential.
 *
 * v1 had two redactors with different strength and used the weaker one on the
 * git path. These tests pin the union.
 */

const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ";

describe("redactCredentials", () => {
  it("strips userinfo from an embedded-token clone URL", () => {
    const msg = `Command failed: git clone https://x-access-token:${TOKEN}@github.com/o/r /tmp/dir`;
    const clean = redactCredentials(msg);
    expect(clean).not.toContain(TOKEN);
    expect(clean).toContain("https://github.com/o/r");
  });

  it("strips a BARE token that is not part of a URL", () => {
    // The gap this consolidation closes. `lib/indexer.ts`'s redactor only
    // matched `://user@`, so a token in prose — which is what the GitHub REST
    // API returns, and what `git` prints for an auth failure — went through
    // untouched on the git path while being redacted on the GitHub path.
    const msg = `remote: Invalid username or password for token ${TOKEN}`;
    const clean = redactCredentials(msg);
    expect(clean).not.toContain(TOKEN);
    expect(clean).toContain("[redacted-token]");
  });

  it("covers every GitHub token prefix", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const secret = `${prefix}_0123456789abcdefghijKLMNOP`;
      expect(redactCredentials(`token=${secret}`)).not.toContain(secret);
    }
  });

  it("leaves an ordinary message untouched", () => {
    // The counterweight: over-redacting would destroy the diagnostic value of
    // the error, which is the reason it is logged at all.
    const msg = "fatal: repository 'https://github.com/o/r' not found";
    expect(redactCredentials(msg)).toBe(msg);
  });

  it("does not mangle a short identifier that merely starts like a token", () => {
    // 16+ payload characters are required, so ordinary prose survives.
    expect(redactCredentials("see ghp_short for details")).toBe("see ghp_short for details");
  });

  it("redacts every occurrence, not just the first", () => {
    const msg = `${TOKEN} then https://u:${TOKEN}@github.com/o/r then ${TOKEN}`;
    expect(redactCredentials(msg)).not.toContain(TOKEN);
  });
});

describe("redactError", () => {
  it("redacts message, cmd, stderr and stdout", () => {
    // `.cmd` is the field that mattered and that v1 never scrubbed: execFile
    // puts the whole command line there, token included, and only `.message`
    // was redacted at a single route boundary.
    const e = Object.assign(new Error(`failed cloning https://x:${TOKEN}@github.com/o/r`), {
      cmd: `git clone https://x:${TOKEN}@github.com/o/r`,
      stderr: `remote: bad credentials ${TOKEN}`,
      stdout: `also ${TOKEN}`,
    });

    const out = redactError(e) as Error & { cmd: string; stderr: string; stdout: string };
    expect(out.message).not.toContain(TOKEN);
    expect(out.cmd).not.toContain(TOKEN);
    expect(out.stderr).not.toContain(TOKEN);
    expect(out.stdout).not.toContain(TOKEN);
  });

  it("preserves the error identity so callers can still match on it", () => {
    // Returned in place rather than cloned: the error is usually rethrown, and a
    // clone would lose the prototype and stack that call sites match on.
    class CloneFailed extends Error {}
    const e = new CloneFailed("boom");
    const out = redactError(e);
    expect(out).toBe(e);
    expect(out).toBeInstanceOf(CloneFailed);
    expect((out as Error).stack).toBeDefined();
  });

  it("passes a non-Error through unchanged", () => {
    expect(redactError("just a string")).toBe("just a string");
    expect(redactError(undefined)).toBeUndefined();
  });

  it("leaves non-string cmd/stderr fields alone", () => {
    // Defensive: these come off an untyped child_process error.
    const e = Object.assign(new Error("x"), { cmd: 42, stderr: null });
    expect(() => redactError(e)).not.toThrow();
  });
});
