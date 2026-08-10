// Server-side git operations over a repo's persistent workspace directory.
//
// All commands run via execFile (argv array — never a shell string), so there is no
// COMMAND-injection surface even with attacker-controlled branch names, commit messages,
// or file paths. That sentence used to end the comment, and it was true and insufficient:
// the absence of a shell says nothing about ARGUMENT injection, where a value that reaches
// argv unvalidated is read by git itself as an OPTION rather than as data. See
// `assertRefArg` below for the two live vulnerabilities that produced.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childEnv } from "@codegraph/config";
import type {
  GitBranch,
  GitFileStatus,
  GitLogEntry,
  GitStatus,
  GitStatusEntry,
} from "@codegraph/core-domain";
import { redactError } from "./redact";

const exec = promisify(execFile);

// childEnv rather than a config value: git needs the inherited environment
// (PATH, HOME, SSH_AUTH_SOCK, proxy vars) to function. GIT_TERMINAL_PROMPT=0
// makes a credential prompt fail fast instead of hanging the request forever.
// Snapshotted at module load, exactly as before.
const GIT_ENV = childEnv({ GIT_TERMINAL_PROMPT: "0" });

/** True iff `url`'s host is exactly `github.com` — the only host we ever
 *  attach a GitHub OAuth/PAT token to. Every call site that embeds a token
 *  into a remote URL (push, PR creation) MUST gate on this first, so a
 *  session's or user-supplied token can never be sent to an attacker-
 *  controlled remote (see docs/AUDIT_2026-07-12.md F006). */
export function isGithubHost(url: string): boolean {
  try {
    return new URL(url).hostname === "github.com";
  } catch {
    return false;
  }
}

/**
 * Every git invocation goes through here, which is why redaction lives here.
 *
 * `push()` puts a token-bearing remote URL in argv, so a failure produces an
 * Error whose `.cmd` contains a live credential — and `.cmd` was NOT redacted
 * anywhere in v1. Only `.message` was, at one route boundary. Doing it at the
 * choke point makes LLD §10.2's "every error path through vcs passes through
 * redactCredentials" structurally true rather than a rule 15 call sites have to
 * remember.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, env: GIT_ENV, maxBuffer: 1024 * 1024 * 32 });
    return stdout;
  } catch (e) {
    throw redactError(e);
  }
}

/**
 * Refuse a caller-supplied value that git would read as an option.
 *
 * TWO CONFIRMED VULNERABILITIES, both anonymous against a public-bucket repo, both fixed by
 * this one check. Neither needed a shell:
 *
 *   · ARBITRARY FILE READ. `POST /api/repos/:id/git {"op":"checkout","name":"--pathspec-from-file=/etc/passwd"}`
 *     reached `git checkout <name>`. git read the file as a list of pathspecs and printed one
 *     `error: pathspec '<line>' did not match ...` per LINE OF THAT FILE, and the route
 *     forwards git's stderr to the client. Reproduced against a scratch repo: the file's
 *     contents came back in the 409 body, line by line.
 *
 *   · ARBITRARY FILE WRITE. `?op=diffFiles&base=--output=/app/data/x&head=HEAD` produced the
 *     single argv token `--output=/app/data/x..HEAD`, and `git diff` created that file.
 *     Reproduced: the file appeared on disk. Both diff call sites swallow errors, so the
 *     write was completely silent.
 *
 * A leading `-` is the whole test, and it is sufficient rather than merely convenient: git
 * treats a token as an option if and only if it begins with `-`, and no legal branch name or
 * revision may start with one (`git check-ref-format` rejects it, and `-` is reserved for
 * `git switch -`). So this rejects exactly the inputs that were never valid data.
 *
 * Checked at the argv boundary rather than in the route, for the same reason redaction is:
 * there are four call sites today and the next one must not have to remember. The
 * alternative — passing `--end-of-options` — would work on git ≥ 2.24 but leaves the
 * confusing git error in place where this produces a clear refusal.
 */
function assertRefArg(kind: "branch" | "revision", value: string): void {
  if (value.startsWith("-")) {
    throw new Error(`Invalid ${kind}: must not start with "-"`);
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Current commit hash of `dir`'s checked-out HEAD, or null if it isn't a
 *  git repo (e.g. a local-folder source) or has no commits yet. */
export async function getHeadHash(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

function mapPorcelainCode(x: string, y: string): GitFileStatus {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R") return "renamed";
  return "modified";
}

export async function getStatus(dir: string): Promise<GitStatus> {
  const raw = await git(dir, ["status", "--porcelain=v2", "--branch"]);
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const entries: GitStatusEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      if (branch === "(detached)") detached = true;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      continue;
    }
    if (line.startsWith("#")) continue;
    // Ordinary changed entry: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
    // Renamed/copied entry:   "2 <XY> ... <path>\t<origPath>"
    // Untracked entry:        "? <path>"
    const parts = line.split(" ");
    const kind = parts[0];
    if (kind === "?") {
      const p = line.slice(2);
      entries.push({ path: p, status: "untracked", staged: false });
    } else if (kind === "1" || kind === "2") {
      const xy = parts[1] || "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const status = mapPorcelainCode(x, y);
      const staged = x !== "." && x !== "?";
      const rest = line.split("\t");
      const pathPart = kind === "2" ? (rest[0] ?? "").split(" ").slice(9).join(" ") : parts.slice(8).join(" ");
      entries.push({ path: pathPart || parts[parts.length - 1] || "", status, staged });
    } else if (kind === "u") {
      const p = parts.slice(10).join(" ");
      entries.push({ path: p, status: "conflicted", staged: false });
    }
  }
  return { branch, ahead, behind, clean: entries.length === 0, entries, detached };
}

/**
 * Every branch the editor's picker can offer: what is on disk, plus what the remote has.
 *
 * WHY THE `ls-remote` HALF EXISTS. The workspace clone is `--single-branch` (see
 * `acquire.ts` — without it, `--depth 50` fetched 50 commits on every branch, which
 * dominates the clone on a repository with hundreds of them). A single-branch clone has
 * exactly one remote-tracking ref, so `git branch -a` alone would have reduced this list
 * to the checked-out branch and silently turned the branch picker into a read-only label.
 * `ls-remote` answers from the remote's ref advertisement — one round trip, no objects —
 * so the picker keeps showing every branch and `checkoutBranch` downloads only the one
 * that is actually chosen.
 *
 * The remote half is BEST-EFFORT on purpose: a workspace on a laptop that is offline, or
 * behind a remote that has since gone away, must still list its local branches rather than
 * fail the whole panel.
 */
export async function listBranches(dir: string): Promise<GitBranch[]> {
  // %(symref:short) is non-empty only for symbolic refs (e.g. the remote's
  // HEAD -> origin/master alias) — those aren't real branches, skip them.
  const raw = await git(dir, ["branch", "-a", "--format=%(refname:short)|%(HEAD)|%(symref:short)"]);
  const out: GitBranch[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [name, head, symref] = line.split("|");
    if (!name || seen.has(name) || symref) continue;
    seen.add(name);
    const remote = name.startsWith("origin/");
    out.push({ name, current: head === "*", remote });
  }

  try {
    // `http.followRedirects=false` for the same reason `acquire.ts` sets it on every
    // network invocation: this contacts a URL the workspace's own config supplies, and
    // git's default follows the first redirect wherever it points.
    const heads = await git(dir, ["-c", "http.followRedirects=false", "ls-remote", "--heads", "origin"]);
    for (const line of heads.split("\n")) {
      // "<sha>\trefs/heads/<name>". A branch name may contain "/", so this cannot split on it.
      const ref = line.split("\t")[1];
      if (ref === undefined || !ref.startsWith("refs/heads/")) continue;
      const name = `origin/${ref.slice("refs/heads/".length)}`;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, current: false, remote: true });
    }
  } catch {
    // Offline, or the remote is gone. The local branches are still a usable answer.
  }
  return out;
}

export async function createBranch(dir: string, name: string, from?: string): Promise<void> {
  // git happens to reject an option in either slot here on its own, so this pair is
  // defence in depth rather than a fix. It is still checked: the guarantee should hold
  // because this function enforces it, not because a git version's argument parser does.
  assertRefArg("branch", name);
  if (from !== undefined) assertRefArg("revision", from);
  const args = from ? ["checkout", "-b", name, from] : ["checkout", "-b", name];
  await git(dir, args);
}

/**
 * Refuse a branch name that cannot be spliced into a fetch REFSPEC.
 *
 * `assertRefArg` covers option injection, which is a different question: inside
 * `+refs/heads/<name>:refs/remotes/origin/<name>` the characters below are STRUCTURAL, and
 * `:` in particular would let one name describe a different destination ref. Every
 * character rejected here is one `git check-ref-format` also rejects, so this refuses
 * exactly the names that could never have named a real branch.
 */
function assertRefspecSafe(name: string): void {
  if (name === "" || /[\s:?*[\\^~]/.test(name) || name.includes("..") || name.includes("@{")) {
    throw new Error("Invalid branch: not a valid branch name");
  }
}

/**
 * Check out `name`, downloading it first when the single-branch clone did not include it.
 *
 * The fetch is what keeps branch switching working now that the workspace clone is
 * `--single-branch`: a branch the picker learned about from `ls-remote` has no local ref
 * yet, and `git checkout` on it would fail with "pathspec did not match any file(s) known
 * to git" — the picker would list every branch and refuse to switch to most of them.
 *
 * `--depth 50` matches the clone, so switching costs one branch rather than the whole
 * history. The `git checkout <name>` that follows is unchanged, which keeps today's
 * semantics exactly: a bare name gets git's DWIM tracking branch, an explicit `origin/x`
 * lands on a detached HEAD as it always has.
 */
export async function checkoutBranch(dir: string, name: string): Promise<void> {
  // The arbitrary-file-read primitive. See assertRefArg.
  assertRefArg("branch", name);
  const short = name.startsWith("origin/") ? name.slice("origin/".length) : name;
  if (!(await refResolves(dir, name)) && !(await refResolves(dir, `origin/${short}`))) {
    assertRefspecSafe(short);
    await git(dir, [
      "-c",
      "http.followRedirects=false",
      "fetch",
      "--depth",
      "50",
      "origin",
      `+refs/heads/${short}:refs/remotes/origin/${short}`,
    ]);
  }
  await git(dir, ["checkout", name]);
}

/** Whether `ref` names something in THIS repository. Callers have already run `assertRefArg`. */
async function refResolves(dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `remoteUrl` mirrors `push` below: supply a credentialed URL per invocation rather than
 * relying on one baked into `.git/config`.
 *
 * The workspace clone used to carry `https://x-access-token:<PAT>@github.com/...` as its
 * stored remote, which put a live `repo`-scoped token in plaintext on the persistent disk for
 * the lifetime of the workspace. `push` already took its credential this way; `pull` did not,
 * and that asymmetry was the only reason the stored URL had to keep the token.
 *
 * `--ff-only` is kept: a merge commit nobody asked for is not a "pull".
 */
export async function pull(dir: string, remoteUrl?: string): Promise<string> {
  if (remoteUrl) {
    const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return git(dir, ["pull", "--ff-only", remoteUrl, branch]);
  }
  return git(dir, ["pull", "--ff-only"]);
}

export async function push(dir: string, remoteUrl?: string): Promise<string> {
  if (remoteUrl) {
    const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return git(dir, ["push", remoteUrl, `HEAD:${branch}`]);
  }
  return git(dir, ["push"]);
}

export async function commit(dir: string, message: string, authorName = "CodeGraph Editor", authorEmail = "editor@codegraph.dev"): Promise<string> {
  await git(dir, ["add", "-A"]);
  return git(dir, ["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "commit", "-m", message]);
}

export async function diffFile(dir: string, relPath: string): Promise<string> {
  try {
    return await git(dir, ["diff", "HEAD", "--", relPath]);
  } catch {
    return "";
  }
}

/**
 * The full unified diff between two revisions, for PR analysis.
 *
 * `--unified=0` because the only consumer intersects the changed line ranges with symbol
 * spans: context lines widen every hunk by three lines in each direction, which would attribute
 * a change to whatever function happens to sit next to it. Three lines is enough to reach into
 * a neighbouring symbol, so this is a correctness choice, not a size one.
 *
 * `--no-color` and `--no-ext-diff` because a repository can set `diff.external` and
 * `color.diff` in its OWN `.git/config`, and both would otherwise apply here: the first runs a
 * command of the repository's choosing, the second corrupts the parse with escape codes. The
 * editor API can no longer write `.git/config`, but a CLONED repository brings its own, so the
 * flags are the guard that does not depend on that.
 *
 * Two dots, not three: `base..head` is "what changed between these commits", while `...` is
 * "what changed on head since the merge base", which silently answers a different question
 * when base has moved on.
 */
export async function diffRange(dir: string, base: string, head: string): Promise<string> {
  // BOTH, because the two are concatenated into ONE argv token below: a leading `-` on either
  // makes the whole token an option to `git diff`.
  assertRefArg("revision", base);
  assertRefArg("revision", head);
  return git(dir, [
    "diff",
    // Subcommand options, not top-level git options — `git --no-ext-diff` is not a thing.
    "--no-ext-diff",
    "--no-color",
    "--unified=0",
    `${base}..${head}`,
  ]);
}

export async function diffCommitsFile(dir: string, base: string, head: string, relPath: string): Promise<string> {
  // The arbitrary-file-write primitive: `base` and `head` are concatenated into ONE argv
  // token, so a leading `-` on either makes the whole token an option. Checked BEFORE the
  // try, so a rejected revision surfaces as an error rather than as an empty diff — the
  // catch below exists to swallow "no such commit", not to hide a refusal.
  assertRefArg("revision", base);
  assertRefArg("revision", head);
  try {
    return await git(dir, ["diff", `${base}..${head}`, "--", relPath]);
  } catch {
    return "";
  }
}

export async function getCommitDiffFiles(dir: string, base: string, head: string): Promise<Array<{ status: string, path: string }>> {
  assertRefArg("revision", base);
  assertRefArg("revision", head);
  try {
    const out = await git(dir, ["diff", "--name-status", `${base}..${head}`]);
    if (!out.trim()) return [];
    // One pass. The original mapped twice — taking the first character of the
    // status, re-joining the path, then re-splitting it by tab — and its own
    // comment ("To be safe:") admitted it was unsure. `--name-status` prints
    // `R100\told\tnew` for a rename, so the NEW path is always the last field.
    return out
      .trim()
      .split("\n")
      .flatMap((line) => {
        const fields = line.split("\t");
        const status = fields[0]?.trim()[0];
        const filePath = fields[fields.length - 1]?.trim();
        // A line missing either half is not a diff entry; dropping it is
        // truthful, where the previous version emitted `status: undefined`.
        if (!status || !filePath) return [];
        return [{ status, path: filePath }];
      });
  } catch {
    return [];
  }
}

export async function restoreFile(dir: string, relPath: string): Promise<void> {
  try {
    // use checkout instead of restore for maximum compatibility with older git versions
    await git(dir, ["checkout", "HEAD", "--", relPath]);
  } catch (e) {
    // If it's an untracked file, checkout HEAD -- file fails. We fall back to cleaning it.
    try {
      await git(dir, ["clean", "-f", "--", relPath]);
    } catch {
      throw new Error(`Failed to revert file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Upper bound on one `log()` call. The whole result is buffered in memory as a single
 * string before it is split, so an unbounded count is a memory amplifier: one request
 * asking for a million commits of a large repository is answered by reading all of it.
 */
const MAX_LOG_LIMIT = 1000;

export async function log(dir: string, limit = 30): Promise<GitLogEntry[]> {
  // `-${limit}` puts the caller's number straight into an argv token, and the callers are
  // HTTP routes doing `Number(searchParams.get("limit")) || 30`. A negative value produced
  // `--5`, which git rejects with a usage error — surfacing as a 500 on a request that is
  // merely malformed. Non-integers (`1.5`, `1e21`) failed the same way. Normalise here
  // rather than at each route: this is the function that owns the argv.
  const count = Number.isFinite(limit)
    ? Math.min(MAX_LOG_LIMIT, Math.max(1, Math.trunc(limit)))
    : 30;
  const sep = "\u0001";
  const raw = await git(dir, ["log", `-${count}`, `--pretty=format:%H${sep}%an${sep}%ad${sep}%s`, "--date=iso-strict"]);
  if (!raw.trim()) return [];
  return raw.split("\n").map((line) => {
    // Destructuring defaults, not `!`: git's own --pretty format always emits
    // all four fields, so these are unreachable for well-formed output, but an
    // empty string is a truthful value where `undefined` would silently vanish
    // from the JSON response.
    const [hash = "", author = "", date = "", ...rest] = line.split(sep);
    return { hash, author, date, message: rest.join(sep) };
  });
}

/** Build a remote URL with an embedded PAT for push auth (never persisted;
 *  the token only ever lives in-memory for the duration of this call). */
export function withToken(remoteUrl: string, token: string): string {
  const m = remoteUrl.match(/^https:\/\/(?:[^@]+@)?(.+)$/);
  if (!m) return remoteUrl;
  return `https://x-access-token:${token}@${m[1]}`;
}
