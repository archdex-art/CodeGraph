// Local-filesystem access (folder browsing + "local folder" indexing) reads
// and indexes arbitrary paths on whatever machine runs this server. That's
// the whole point when self-hosting CodeGraph against your own disk — and a
// live file-disclosure hole when the server is a shared/public deployment
// (e.g. a Render web service anyone can reach). Default: allowed only when
// NODE_ENV isn't "production". Explicitly opt in on a trusted production
// host (a private VPC self-host, a single-operator box) with
// CG_ALLOW_LOCAL_ACCESS=true; explicitly opt out of a permissive dev default
// with CG_ALLOW_LOCAL_ACCESS=false.
export function localAccessAllowed(): boolean {
  if (process.env.CG_ALLOW_LOCAL_ACCESS === "true") return true;
  if (process.env.CG_ALLOW_LOCAL_ACCESS === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export const LOCAL_ACCESS_DISABLED_MESSAGE =
  "Local-folder indexing and server-side folder browsing are disabled on this deployment to prevent exposing its filesystem to visitors. Use a Git URL instead, or self-host CodeGraph and set CG_ALLOW_LOCAL_ACCESS=true if this really is a trusted, single-operator host.";
