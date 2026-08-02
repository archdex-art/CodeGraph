import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { config } from "@codegraph/config";

// Local-filesystem access (folder browsing + "local folder" indexing) reads
// and indexes arbitrary paths on whatever machine runs this server. That's
// the whole point when self-hosting CodeGraph against your own disk — and a
// live file-disclosure hole when the server is a shared/public deployment
// (e.g. a Render web service anyone can reach). Default: allowed only when
// NODE_ENV isn't "production". Explicitly opt in on a trusted production
// host (a private VPC self-host, a single-operator box) with
// CG_ALLOW_LOCAL_ACCESS=true; explicitly opt out of a permissive dev default
// with CG_ALLOW_LOCAL_ACCESS=false.
//
// The tri-state default lives in @codegraph/config; this stays a function
// rather than becoming a re-exported constant because callers treat it as a
// runtime check and inlining `config.allowLocalAccess` at 6 call sites would
// scatter the concept.
export function localAccessAllowed(): boolean {
  return config.allowLocalAccess;
}

export const LOCAL_ACCESS_DISABLED_MESSAGE =
  "Local-folder indexing and server-side folder browsing are disabled on this deployment to prevent exposing its filesystem to visitors. Use a Git URL instead, or self-host CodeGraph and set CG_ALLOW_LOCAL_ACCESS=true if this really is a trusted, single-operator host.";

/**
 * F016: optional defence-in-depth containment for local-filesystem access.
 *
 * `localAccessAllowed()` is the primary gate; `CG_LOCAL_ACCESS_ROOT` narrows what that
 * permission covers, so a misconfigured local-access opt-in does not automatically mean
 * whole-disk exposure. Off by default — an unset root preserves unrestricted behaviour.
 *
 * This lives beside `localAccessAllowed()` rather than in a route because it was in a
 * route, and only one of the two entry points had it: `/api/browse` refused a path
 * outside the root while `/api/index` indexed it. Indexing is the STRICTLY more powerful
 * operation — browse discloses directory names, indexing walks the tree and makes file
 * contents readable through the repo's fs/search/editor endpoints — so the boundary was
 * enforced on the weaker path only. Both callers now share one implementation.
 */
export function withinLocalAccessRoot(target: string): boolean {
  const configuredRoot = config.localAccessRoot;
  if (!configuredRoot) return true;
  try {
    const rootReal = realpathSync(path.resolve(configuredRoot));
    // A path that does not exist yet cannot be realpath'd, and resolving it purely
    // lexically is wrong wherever the root's own path crosses a symlink: on macOS
    // `/var` is a link to `/private/var`, so a lexical `/var/.../new-dir` never matched
    // a root that realpath'd to `/private/var/...` and every not-yet-created path inside
    // the root was refused. Resolve the nearest EXISTING ancestor and re-attach the rest.
    const resolved = path.resolve(target);
    let existing = resolved;
    while (!existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return false; // walked to the filesystem root; nothing to anchor on
      existing = parent;
    }
    const targetReal = path.join(realpathSync(existing), path.relative(existing, resolved));
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
  } catch {
    return false;
  }
}

export const LOCAL_ACCESS_ROOT_MESSAGE = "Path is outside the configured local-access root";
