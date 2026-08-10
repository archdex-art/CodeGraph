import { describe, expect, it } from "vitest";
import { classifyIndexFailure, INDEX_FAILURE_MESSAGES, type IndexFailureCause } from "@/lib/store";

/**
 * What an indexing failure is allowed to tell a stranger.
 *
 * Reproduced before this existed: submitting `https://example.com/foo/bar` on the landing
 * page rendered the raw `execFile` rejection to an anonymous visitor — the absolute data
 * directory, the workspace UUID, and the full `git clone` argv including the SSRF guard's
 * flags — to deliver the two words "not found". These tests pin both halves of the fix:
 * the classifier recognises the errors this codebase ACTUALLY produces (the fixtures below
 * are `packages/vcs/src/acquire.ts`'s invocation verbatim, not paraphrases), and no branch
 * of it can emit a string carrying a path, a UUID or a command line.
 */

/** The exact shape `child_process` rejects with: message, plus the stderr git wrote. */
function execFileError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

const WORKSPACE = "/Users/archdex/Desktop/contentcreation_ideas/CodeGraph/apps/web/data/workspaces";
const UUID = "6ee8aa2a-3635-4830-b9d6-2c456b9216b9";
const CLONE_ARGV = `git -c http.followRedirects=false clone --depth 50 https://example.com/foo/bar ${WORKSPACE}/${UUID}`;

/** The leak that motivated all of this, byte for byte. */
const REPRODUCED_LEAK = execFileError(
  `Command failed: ${CLONE_ARGV}\nCloning into '${WORKSPACE}/${UUID}'...\nfatal: repository 'https://example.com/foo/bar/' not found\n`,
  { stderr: `Cloning into '${WORKSPACE}/${UUID}'...\nfatal: repository 'https://example.com/foo/bar/' not found\n`, code: 128 },
);

const FIXTURES: ReadonlyArray<readonly [IndexFailureCause, unknown]> = [
  ["repo-not-found", REPRODUCED_LEAK],
  [
    // GIT_TERMINAL_PROMPT=0 is why this is the auth failure rather than a hang.
    "auth-required",
    execFileError(`Command failed: ${CLONE_ARGV}`, {
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
    }),
  ],
  [
    "host-unreachable",
    execFileError(`Command failed: ${CLONE_ARGV}`, {
      stderr: "fatal: unable to access 'https://nope.invalid/o/r/': Could not resolve host: nope.invalid\n",
    }),
  ],
  [
    // execFile sends SIGTERM at `cloneTimeoutMs` and prints nothing that says so, which is
    // why the classifier reads the flags rather than the text for this one.
    "clone-timeout",
    execFileError(`Command failed: ${CLONE_ARGV}`, { killed: true, signal: "SIGTERM" }),
  ],
  ["disk-full", execFileError(`ENOSPC: no space left on device, write '${WORKSPACE}/${UUID}/.git/objects/pack'`)],
  [
    "not-a-git-repo",
    execFileError(`Command failed: git -C ${WORKSPACE}/${UUID} rev-parse HEAD`, {
      stderr: `fatal: not a git repository (or any of the parent directories): .git\n`,
    }),
  ],
  // `cloneRepo`'s own pre-flight rejection, and the SSRF guard's wording from /api/index.
  ["blocked-url", new Error("Invalid repository URL. Use a public https git URL.")],
  [
    "blocked-url",
    execFileError("Command failed: git clone ftp://example.com/r", {
      stderr: "fatal: transport 'ftp' not allowed\n",
    }),
  ],
  [
    "local-access-denied",
    new Error(
      "Local-folder indexing and server-side folder browsing are disabled on this deployment to prevent exposing its filesystem to visitors.",
    ),
  ],
  ["local-access-denied", new Error("Path is outside the configured local-access root")],
  // `resolveLocalDir`'s two throws: both interpolate the resolved absolute path.
  ["local-path-unreadable", new Error(`Path does not exist: ${WORKSPACE}/${UUID}`)],
  ["local-path-unreadable", new Error(`Not a directory: ${WORKSPACE}/${UUID}`)],
  ["unknown", execFileError("SQLITE_BUSY: database is locked")],
  // Not an Error at all — a `throw "string"` from somewhere must not crash the classifier.
  ["unknown", "something went sideways"],
];

describe("classifyIndexFailure", () => {
  it.each(FIXTURES)("maps a real %s failure to its cause and safe message", (cause, raw) => {
    const result = classifyIndexFailure(raw);
    expect(result.cause).toBe(cause);
    expect(result.message).toBe(INDEX_FAILURE_MESSAGES[cause]);
  });

  it("gives every cause an actionable sentence and no interpolation slot", () => {
    for (const [cause, message] of Object.entries(INDEX_FAILURE_MESSAGES)) {
      // A sentence, not a token: the string is rendered on its own as the whole failure.
      expect(message, cause).toMatch(/^[A-Z].*\.$/s);
      // Every one of them has to leave the reader with a next move.
      expect(message, cause).toMatch(/check|sign in|retry|try again|use a|delete|point/i);
      // Nothing may be spliced in later without this test noticing.
      expect(message, cause).not.toMatch(/[${}]|%s/);
    }
  });
});

describe("the reproduced landing-page leak", () => {
  const { message } = classifyIndexFailure(REPRODUCED_LEAK);

  it("keeps the useful diagnosis", () => {
    expect(message).toBe("Repository not found. Check the URL, or sign in if it is private.");
  });

  it.each([
    ["the absolute data directory", WORKSPACE],
    ["the workspace UUID", UUID],
    ["the command line", "Command failed:"],
    ["git's flags", "http.followRedirects"],
    ["git's own prose", "fatal:"],
  ])("does not carry %s", (_label, needle) => {
    expect(message).not.toContain(needle);
  });
});

/**
 * The fallback is the branch that runs for errors nobody predicted, so it is the one most
 * likely to be handed something with a path in it. It must still say something useful and
 * must not degrade into echoing its input.
 */
describe("the unknown fallback", () => {
  const RANDOM_LEAKY = execFileError(
    `Command failed: /usr/local/bin/some-tool --config ${WORKSPACE}/${UUID}/cfg.json\nsegmentation fault (core dumped)`,
  );

  it("leaks nothing from an unrecognised error", () => {
    // Deliberately not in any pattern list, and stuffed with everything that must not escape.
    const { cause, message } = classifyIndexFailure(RANDOM_LEAKY);
    expect(cause).toBe("unknown");
    expect(message).not.toContain(WORKSPACE);
    expect(message).not.toContain(UUID);
    expect(message).not.toContain("Command failed:");
    expect(message).toBe(INDEX_FAILURE_MESSAGES.unknown);
  });

  it("still tells the reader what to do next", () => {
    expect(INDEX_FAILURE_MESSAGES.unknown).toMatch(/retry/i);
  });
});
