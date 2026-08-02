/**
 * Credential redaction for everything leaving `vcs` (LLD §10.2).
 *
 * `git` embeds an access token directly in the remote URL
 * (`https://x-access-token:<token>@github.com/o/r`), and it echoes that URL back
 * in its own error messages, in `err.cmd`, and in `err.stderr`. Anything that
 * forwards one of those verbatim — a log line, a stored job error, an API
 * response — leaks a live credential. That is F004/F017 and the reason this
 * function has to be applied at the boundary rather than remembered per call
 * site.
 *
 * CONSOLIDATION NOTE: v1 had two different redactors. `redactCredentials` in
 * `lib/indexer.ts` stripped only URL userinfo, while `redactToken` in
 * `lib/githubApi.ts` also matched bare `gh*_` token strings. A token that
 * appeared in a message WITHOUT being part of a URL — which is what the GitHub
 * REST API returns, and what `git` prints for an auth failure — was therefore
 * redacted on one path and not the other. This is the union of both, applied
 * everywhere, so the weaker path no longer exists.
 */

/**
 * GitHub's token prefixes: `ghp_` personal, `gho_` OAuth, `ghu_` user-to-server,
 * `ghs_` server-to-server, `ghr_` refresh. 16+ chars of payload keeps this from
 * matching ordinary prose that happens to start with those four characters.
 */
const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{16,}/g;

/** `scheme://anything@` — the userinfo component of a URL, token or password. */
const URL_USERINFO_RE = /:\/\/[^\s@/]+@/g;

export function redactCredentials(s: string): string {
  return s.replace(GITHUB_TOKEN_RE, "[redacted-token]").replace(URL_USERINFO_RE, "://");
}

/**
 * Redact an error in place, including the fields `child_process` attaches.
 *
 * `execFile` rejects with an Error carrying `cmd` and `stderr`, and the full
 * command line — token and all — is in `cmd`. Redacting only `.message` leaves
 * the credential sitting on the object for whatever logs or serialises it next,
 * which is exactly how it escaped before.
 *
 * Mutates rather than clones deliberately: the error is usually rethrown, and a
 * clone would lose the prototype and stack that callers match on.
 */
export function redactError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  e.message = redactCredentials(e.message);
  const withFields = e as Error & { cmd?: unknown; stderr?: unknown; stdout?: unknown };
  if (typeof withFields.cmd === "string") withFields.cmd = redactCredentials(withFields.cmd);
  if (typeof withFields.stderr === "string") withFields.stderr = redactCredentials(withFields.stderr);
  if (typeof withFields.stdout === "string") withFields.stdout = redactCredentials(withFields.stdout);
  return e;
}
