import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * The natural key of a repository: what makes two index runs "the same repo".
 *
 * WHY THIS EXISTS. `createIndexJob` used to mint a fresh UUID per submission, so the row was
 * keyed by nothing at all and re-indexing inserted a second repository. The dashboard showed
 * `sindresorhus/slugify` four times and `CodeGraph` twice with two contradictory scores
 * (92,360 LOC / 71 and 673,544 LOC / 76) and no indication which was current — a health score
 * that disagrees with itself is worse than no score, because both readings look authoritative.
 *
 * The key is the tuple (owner, source type, canonical target). Owner is part of it because two
 * accounts indexing the same public repository must each get their own row: the analysis is
 * theirs, and merging them would leak one tenant's run into the other's dashboard. Source type
 * is part of it because a git URL and a local checkout of the same code are two different
 * things to re-index — one fetches, the other reads a directory the user owns.
 *
 * What is left is the target string, and a target string that a human pasted is never
 * canonical. `canonicalTarget` is the ONLY place that decides two spellings mean one
 * repository; anything else comparing `repos.url` directly is a second opinion waiting to
 * disagree with this one.
 */

/**
 * `git@github.com:owner/repo.git` — the scp-like form GitHub's own clone menu hands out.
 *
 * It is not a URL and `new URL` rejects it, so without this it would fall through to the
 * verbatim branch and never collapse with the https spelling of the same repository. The
 * negative lookahead on the path keeps `https://host/x` out: there the colon is followed by
 * `//`, which is a scheme, not an scp host separator.
 */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^@/:\s]+):(?!\/)(.+)$/;

/**
 * Everything after the host, with the noise a paste picks up removed.
 *
 * Order matters: the trailing slash comes off first because `…/Bar.git/` hides the `.git`
 * behind it, and a second slash strip follows because stripping `.git` from `…/Bar.git/`
 * cannot happen until the slash is gone. The leading slash goes so `host` + `/` + `path`
 * below joins exactly once regardless of which branch produced the path.
 */
function canonicalPath(raw: string): string {
  return raw
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");
}

/**
 * A git remote reduced to `host/path`, lowercased.
 *
 * NO SCHEME, NO CREDENTIALS, NO PORT. `https://`, `ssh://` and `git://` of one host and path
 * are the same repository reached three ways — the transport is a property of how this
 * deployment authenticates, not of which code is being analysed — and a port differs for the
 * same reason (ssh on 22, https on 443). Credentials are dropped both because
 * `https://token@github.com/o/r` and `https://github.com/o/r` are obviously one repository and
 * because a key is compared, logged and stored, and a secret has no business in any of those.
 *
 * LOWERCASED IN FULL, path included, which is a deliberate trade. GitHub, GitLab and Bitbucket
 * all resolve `owner/repo` case-insensitively and redirect to the canonical spelling, so
 * `github.com/Foo/Bar` and `github.com/foo/bar` are one clone; the cost is that a self-hosted
 * server on a case-sensitive filesystem could in principle serve two repositories differing
 * only in case, and we would collapse them. Choosing the other way means every user who types
 * a capital letter gets a duplicate row — the failure this function exists to stop, and the one
 * that actually happens.
 */
function canonicalGitUrl(url: string): string {
  const trimmed = url.trim();

  const scp = SCP_LIKE.exec(trimmed);
  if (scp) return `${scp[1]}/${canonicalPath(scp[2] ?? "")}`.toLowerCase();

  try {
    // `URL.hostname` excludes userinfo and port, so both are dropped by construction rather
    // than by a regex that would have to be right about every remote spelling.
    const parsed = new URL(trimmed);
    return `${parsed.hostname}/${canonicalPath(parsed.pathname)}`.toLowerCase();
  } catch {
    // Not parseable as either shape. Normalising what CAN be normalised still collapses the
    // common `…/repo.git` vs `…/repo` pair, and an unrecognised string that keys only to
    // itself is the honest outcome: it dedupes exact re-submissions and merges nothing else.
    return canonicalPath(trimmed).toLowerCase();
  }
}

/**
 * A local folder reduced to the real absolute path of the directory on disk.
 *
 * `realpathSync` rather than `path.resolve` alone because the same directory has many valid
 * spellings — a relative path, a trailing slash, a `..` segment, a symlink, and on macOS
 * `/tmp` which is really `/private/tmp`. Identity here means "the same bytes on disk", and
 * only the filesystem can answer that.
 *
 * NOT lowercased, unlike a git URL: Linux filesystems are case-sensitive and `~/Work` and
 * `~/work` are genuinely two directories. Where the filesystem is case-insensitive,
 * `realpathSync` already returns the on-disk spelling, so the two spellings converge anyway.
 *
 * A path that does not exist (deleted since it was indexed, or a target the caller is about to
 * be refused) falls back to `path.resolve`. It must still key stably — the row for a folder
 * that has since been removed has to remain findable so the user can delete it.
 */
function canonicalLocalPath(target: string): string {
  const absolute = path.resolve(target.trim());
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** The canonical form of an index target, by source type. */
export function canonicalTarget(sourceType: string, target: string): string {
  return sourceType === "local" ? canonicalLocalPath(target) : canonicalGitUrl(target);
}
