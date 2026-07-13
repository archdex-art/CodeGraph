// Server-side git operations over a repo's persistent workspace directory.
// All commands run via execFile (argv array — never a shell string), so
// there is no command-injection surface even with attacker-controlled
// branch names, commit messages, or file paths.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBranch, GitLogEntry, GitStatus, GitStatusEntry, GitFileStatus } from "./types";

const exec = promisify(execFile);

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV, maxBuffer: 1024 * 1024 * 32 });
  return stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
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
      const x = xy[0];
      const y = xy[1];
      const status = mapPorcelainCode(x, y);
      const staged = x !== "." && x !== "?";
      const rest = line.split("\t");
      const pathPart = kind === "2" ? rest[0].split(" ").slice(9).join(" ") : parts.slice(8).join(" ");
      entries.push({ path: pathPart || parts[parts.length - 1], status, staged });
    } else if (kind === "u") {
      const p = parts.slice(10).join(" ");
      entries.push({ path: p, status: "conflicted", staged: false });
    }
  }
  return { branch, ahead, behind, clean: entries.length === 0, entries, detached };
}

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
  return out;
}

export async function createBranch(dir: string, name: string, from?: string): Promise<void> {
  const args = from ? ["checkout", "-b", name, from] : ["checkout", "-b", name];
  await git(dir, args);
}

export async function checkoutBranch(dir: string, name: string): Promise<void> {
  await git(dir, ["checkout", name]);
}

export async function pull(dir: string): Promise<string> {
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

export async function log(dir: string, limit = 30): Promise<GitLogEntry[]> {
  const sep = "\u0001";
  const raw = await git(dir, ["log", `-${limit}`, `--pretty=format:%H${sep}%an${sep}%ad${sep}%s`, "--date=iso-strict"]);
  if (!raw.trim()) return [];
  return raw.split("\n").map((line) => {
    const [hash, author, date, ...rest] = line.split(sep);
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
