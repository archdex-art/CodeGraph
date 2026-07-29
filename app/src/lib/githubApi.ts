// Minimal GitHub REST client for the remediation publish path.
//
// Extracted from executor.ts because the inline version had two defects that
// are only visible once this logic is testable in isolation:
//
//   1. It never checked `res.ok`. A 422 from the pulls endpoint (the common
//      case — "no commits between base and head", or a PR already open for the
//      branch) left the code reporting "Pushed branch and opened GitHub PR",
//      ok=true, while no PR existed. The branch HAD been pushed, so the user's
//      remote was mutated and the UI said something untrue about it.
//   2. It hardcoded `base: "main"`. Every repository whose default branch is
//      `master` — or `develop`, or anything else — got a 422 from (1), which
//      (1) then swallowed.
//
// Every function here throws GitHubApiError on a non-2xx response, with the
// status and GitHub's own message attached, so the caller can report the real
// reason instead of a generic failure.

/** Never let a token reach a log line, an error message, or an API response. */
function redactToken(s: string): string {
  return s
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-token]")
    .replace(/:\/\/[^\s@/]+@/g, "://");
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
  ) {
    super(redactToken(message));
    this.name = "GitHubApiError";
  }
}

export interface GitHubClientOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Extract `{owner, repo}` from a GitHub remote URL.
 *
 * Tolerates a `user:token@` userinfo component (authenticated clone URLs), a
 * trailing `.git`, and a trailing slash. Returns null for anything that isn't
 * a github.com URL — the caller must not fall back to guessing.
 */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

async function ghFetch(
  endpoint: string,
  token: string,
  init: RequestInit,
  opts: GitHubClientOptions,
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    // GitHub returns a JSON body with `message` and often `errors[]`. Surface
    // it — "Validation Failed: No commits between main and codegraph/…" is a
    // fixable problem; "request failed" is not.
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> };
      const extra = body.errors?.map((e) => e.message).filter(Boolean).join("; ");
      detail = [body.message, extra].filter(Boolean).join(": ") || detail;
    } catch {
      /* non-JSON error body — statusText is the best we have */
    }
    throw new GitHubApiError(res.status, endpoint, detail);
  }
  return res.json();
}

/**
 * The repository's real default branch. This is the correct base for a PR;
 * assuming "main" silently breaks every `master`-default repository.
 */
export async function getDefaultBranch(
  owner: string,
  repo: string,
  token: string,
  opts: GitHubClientOptions = {},
): Promise<string> {
  const data = (await ghFetch(`/repos/${owner}/${repo}`, token, { method: "GET" }, opts)) as {
    default_branch?: string;
  };
  if (!data.default_branch) {
    throw new GitHubApiError(200, `/repos/${owner}/${repo}`, "Response omitted default_branch");
  }
  return data.default_branch;
}

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  token: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface PullRequestRef {
  url: string;
  number: number;
}

export async function createPullRequest(
  input: CreatePullRequestInput,
  opts: GitHubClientOptions = {},
): Promise<PullRequestRef> {
  const { owner, repo, token, title, body, head, base } = input;
  const data = (await ghFetch(
    `/repos/${owner}/${repo}/pulls`,
    token,
    { method: "POST", body: JSON.stringify({ title, body, head, base }) },
    opts,
  )) as { html_url?: string; number?: number };

  if (!data.html_url || typeof data.number !== "number") {
    throw new GitHubApiError(201, `/repos/${owner}/${repo}/pulls`, "Response omitted html_url/number");
  }
  return { url: data.html_url, number: data.number };
}
