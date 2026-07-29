import { describe, it, expect } from "vitest";
import {
  parseGithubRepo,
  getDefaultBranch,
  createPullRequest,
  GitHubApiError,
} from "@codegraph/vcs";

/** Minimal fetch double: returns a canned status/body and records the call. */
function fakeFetch(
  status: number,
  body: unknown,
  calls: Array<{ url: string; init: RequestInit }> = [],
): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("parseGithubRepo", () => {
  it.each([
    ["https://github.com/expressjs/express", "expressjs", "express"],
    ["https://github.com/expressjs/express.git", "expressjs", "express"],
    ["https://github.com/expressjs/express/", "expressjs", "express"],
    ["https://www.github.com/a/b", "a", "b"],
    // Authenticated clone URLs carry a userinfo component — must still parse.
    ["https://x-access-token:ghp_secret@github.com/o/r.git", "o", "r"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseGithubRepo(url)).toEqual({ owner, repo });
  });

  it.each([
    ["https://gitlab.com/o/r", "non-github host"],
    ["https://github.com/onlyowner", "no repo segment"],
    ["not a url", "unparseable"],
    // Host must match exactly — an attacker-controlled lookalike must not pass.
    ["https://github.com.evil.tld/o/r", "lookalike host"],
  ])("rejects %s (%s)", (url) => {
    expect(parseGithubRepo(url)).toBeNull();
  });
});

describe("getDefaultBranch", () => {
  it("returns the repository's real default branch", async () => {
    const branch = await getDefaultBranch("o", "r", "tok", {
      fetchImpl: fakeFetch(200, { default_branch: "master" }),
    });
    expect(branch).toBe("master");
  });

  it("sends the token as a Bearer credential and pins the API version", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await getDefaultBranch("o", "r", "tok", {
      fetchImpl: fakeFetch(200, { default_branch: "main" }, calls),
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("throws with GitHub's own message on a non-2xx response", async () => {
    await expect(
      getDefaultBranch("o", "r", "tok", {
        fetchImpl: fakeFetch(404, { message: "Not Found" }),
      }),
    ).rejects.toMatchObject({ status: 404, message: "Not Found" });
  });
});

describe("createPullRequest", () => {
  const input = {
    owner: "o", repo: "r", token: "tok",
    title: "t", body: "b", head: "codegraph/auto-remediation", base: "master",
  };

  it("returns the created PR's url and number", async () => {
    const pr = await createPullRequest(input, {
      fetchImpl: fakeFetch(201, { html_url: "https://github.com/o/r/pull/7", number: 7 }),
    });
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7 });
  });

  it("posts the caller-supplied base, never a hardcoded 'main'", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await createPullRequest(input, {
      fetchImpl: fakeFetch(201, { html_url: "u", number: 1 }, calls),
    });
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ base: "master" });
  });

  // The regression this whole module exists for: a 422 used to be swallowed
  // and reported as success while the branch was already pushed.
  it("throws on 422 instead of reporting success", async () => {
    await expect(
      createPullRequest(input, {
        fetchImpl: fakeFetch(422, {
          message: "Validation Failed",
          errors: [{ message: "No commits between master and codegraph/auto-remediation" }],
        }),
      }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("includes GitHub's field-level errors in the thrown message", async () => {
    await expect(
      createPullRequest(input, {
        fetchImpl: fakeFetch(422, {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists" }],
        }),
      }),
    ).rejects.toThrow(/Validation Failed: A pull request already exists/);
  });

  it("throws rather than returning a half-built ref when the body is malformed", async () => {
    await expect(
      createPullRequest(input, { fetchImpl: fakeFetch(201, { number: 7 }) }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("survives a non-JSON error body", async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 502, statusText: "Bad Gateway",
      json: async () => { throw new SyntaxError("not json"); },
    })) as unknown as typeof fetch;
    await expect(createPullRequest(input, { fetchImpl })).rejects.toMatchObject({ status: 502 });
  });
});

/** Run `fn`, expecting it to reject, and return the thrown Error. */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("credential safety", () => {
  it("redacts a token that appears in an error message", async () => {
    const err = await rejection(() =>
      createPullRequest(
        { owner: "o", repo: "r", token: "ghp_aaaaaaaaaaaaaaaaaaaa", title: "t", body: "b", head: "h", base: "m" },
        { fetchImpl: fakeFetch(401, { message: "Bad credentials for ghp_aaaaaaaaaaaaaaaaaaaa" }) },
      ),
    );

    expect(err.message).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
    expect(err.message).toContain("[redacted-token]");
  });

  it("redacts a token embedded in a remote URL inside an error message", async () => {
    const err = await rejection(() =>
      getDefaultBranch("o", "r", "tok", {
        fetchImpl: fakeFetch(500, {
          message: "failed cloning https://x-access-token:secret@github.com/o/r.git",
        }),
      }),
    );

    expect(err.message).not.toContain("secret@");
    expect(err.message).toContain("https://github.com/o/r.git");
  });
});
