// GitHub OAuth (classic web application flow) + a thin GitHub REST client for
// the two calls this feature needs: who is this user, and what repos can
// they see. No server-side app registration/state beyond env vars — the
// access token is handed to lib/session.ts's caller to encrypt into a cookie
// and is never written to disk here.

export function githubOAuthConfigured(): boolean {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET && process.env.CG_SESSION_SECRET);
}

/** Parses CG_OWNER_GITHUB_LOGIN into a lowercased allowlist, or `null` if
 *  unset (= no owner-lock; the app's existing "anonymous public bucket,
 *  GitHub accounts private" model applies unchanged). Comma-separated so an
 *  operator can allow a small team, not just a single account. */
export function ownerLoginAllowlist(): string[] | null {
  const raw = process.env.CG_OWNER_GITHUB_LOGIN;
  if (!raw?.trim()) return null;
  const logins = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return logins.length > 0 ? logins : null;
}

/** Whether `login` (case-insensitive) is allowed when owner-lock is active.
 *  Returns `true` if owner-lock isn't configured at all — callers that need
 *  the "is owner-lock even on" question should check `ownerLoginAllowlist()`
 *  directly instead of relying on this default. */
export function isAllowedOwnerLogin(login: string): boolean {
  const allowlist = ownerLoginAllowlist();
  if (!allowlist) return true;
  return allowlist.includes(login.toLowerCase());
}

// Prefer an explicitly configured public URL (needed behind a proxy like
// Render, where the request's own Host header may not be trustworthy/final
// for building an OAuth redirect_uri that must exactly match what's
// registered on the GitHub OAuth App) over deriving one from the request.
export function publicBaseUrl(requestOrigin: string): string {
  return process.env.NEXT_PUBLIC_APP_URL || requestOrigin;
}

// `repo` scope is required for GitHub's classic OAuth to read/clone PRIVATE
// repos at all (there's no finer-grained "read-only" classic scope); this
// also lets the same token feed the existing editor push feature later
// without a second consent screen. `read:user` gets profile/avatar.
const SCOPES = "repo read:user";

export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    allow_signup: "false",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error_description || data.error || "GitHub token exchange failed");
  }
  return data.access_token;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

function githubApiHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "CodeGraph-App" };
}

export async function fetchGithubUser(token: string): Promise<GithubUser> {
  const res = await fetch("https://api.github.com/user", { headers: githubApiHeaders(token) });
  if (!res.ok) throw new Error(`GitHub profile lookup failed (${res.status})`);
  return res.json();
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
  defaultBranch: string;
  htmlUrl: string;
  language: string | null;
  stargazersCount: number;
}

interface RawGithubRepo {
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  default_branch: string;
  html_url: string;
  language: string | null;
  stargazers_count: number;
}

export async function fetchGithubRepos(token: string, page: number, perPage = 30): Promise<{ repos: GithubRepo[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    sort: "updated",
    per_page: String(perPage),
    page: String(page),
    affiliation: "owner,collaborator,organization_member",
  });
  const res = await fetch(`https://api.github.com/user/repos?${params}`, { headers: githubApiHeaders(token) });
  if (!res.ok) throw new Error(`GitHub repo list failed (${res.status})`);
  const raw = (await res.json()) as RawGithubRepo[];
  const repos = raw.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    updatedAt: r.updated_at,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    language: r.language,
    stargazersCount: r.stargazers_count,
  }));
  // GitHub's list endpoint doesn't return a total count; a short page is the
  // reliable signal that there's nothing more to paginate.
  return { repos, hasMore: raw.length === perPage };
}
