"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Loader2,
} from "lucide-react";
import {
  fetchHealth,
  fetchJob,
  fetchMe,
  startIndex,
  type AuthMe,
} from "@/lib/api";
import { FolderBrowser } from "@/components/FolderBrowser";
import { GithubReposPicker } from "@/components/GithubReposPicker";
import { GithubMark } from "@/components/GithubMark";
import type { Job } from "@/lib/types";

/**
 * The entry point, lifted out of the old page so the landing can compose it.
 *
 * Every behaviour is carried over unchanged — the three modes, the health probe
 * that hides local indexing on a shared deployment, the OAuth return error, the
 * poll loop and its redirect. This is a restyle, and the one thing a restyle
 * must not do is quietly drop a branch that only fires on someone else's
 * deployment.
 */

const EXAMPLES = [
  "https://github.com/sindresorhus/slugify",
  "https://github.com/expressjs/express",
  "https://github.com/pallets/flask",
];

type Mode = "git" | "local" | "github";

export function IndexConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("git");
  const [url, setUrl] = useState("");
  const [pathVal, setPathVal] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  /**
   * The OAuth failure arrives as `?authError=…`. Read during render via
   * `useSearchParams` rather than copied into state by an effect: it is already
   * derivable, and the effect version rendered once without the error before
   * flashing it in. `dismissed` lets the user clear it without the param coming back.
   */
  const authError = searchParams.get("authError");
  const [dismissedAuthError, setDismissedAuthError] = useState(false);
  const [ownError, setOwnError] = useState<string | null>(null);
  const error = ownError ?? (dismissedAuthError ? null : authError);
  const setError = (v: string | null) => {
    setOwnError(v);
    if (v === null) setDismissedAuthError(true);
  };
  // Optimistic; corrected once the health check resolves.
  const [localAccessAllowed, setLocalAccessAllowed] = useState(true);
  const [anonIndexingAllowed, setAnonIndexingAllowed] = useState(true);
  const [me, setMe] = useState<AuthMe | null>(null);
  const busy = job !== null && job.status !== "error";
  /* Signing in is a PRECONDITION here, not an error to discover on submit: without
     it the server refuses with a 401, so the console offers the sign-in instead of a
     button that looks live. Optimistic until the probe resolves, like local access. */
  const needsAuth = !anonIndexingAllowed && !me?.user;

  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setLocalAccessAllowed(h.localAccessAllowed);
        setAnonIndexingAllowed(h.anonymousIndexingAllowed);
        if (!h.localAccessAllowed) setMode((m) => (m === "local" ? "git" : m));
      })
      .catch(() => {}); // the probe failing is not this page's problem; keep the optimistic default

    fetchMe()
      .then(setMe)
      .catch(() => {});

    // Strip the param from the address bar so a refresh does not resurrect the error.
    // No setState here — the message is already derived from the value read at render,
    // and `dismissedAuthError` is what retires it.
    if (window.location.search.includes("authError=")) {
      const next = new URL(window.location.href);
      next.searchParams.delete("authError");
      window.history.replaceState({}, "", next.toString());
    }
  }, []);

  async function startWithInput(input: {
    repoUrl?: string;
    localPath?: string;
  }) {
    setError(null);
    setJob(null);
    try {
      const { jobId, repoId: rid } = await startIndex(input);
      setRepoId(rid);
      poll(jobId, rid);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await startWithInput(
      mode === "git" ? { repoUrl: url.trim() } : { localPath: pathVal.trim() },
    );
  }

  function poll(jobId: string, rid: string) {
    const tick = async () => {
      try {
        const j = await fetchJob(jobId);
        setJob(j);
        if (j.status === "done") {
          setTimeout(() => router.push(`/repos/${rid}`), 600);
          return;
        }
        if (j.status === "error") {
          setError(j.error || "Indexing failed");
          return;
        }
        setTimeout(tick, 1000);
      } catch {
        setTimeout(tick, 1500);
      }
    };
    tick();
  }

  const tab = (active: boolean) =>
    `relative flex min-h-11 shrink-0 cursor-pointer items-center gap-sm whitespace-nowrap rounded-lg px-md text-meta font-medium transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
      active
        ? "text-[var(--accent-on-fill)]"
        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    }`;
  const field =
    "min-h-14 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-md py-md font-mono text-body text-[var(--text-primary)] placeholder-[var(--text-muted)] transition-colors duration-200 focus:border-[var(--signal-600)] focus:outline-none disabled:opacity-50";

  return (
    /* `min-w-0`: a grid/flex child defaults to `min-width:auto`, so it refuses to shrink
       below its content's min-content width. The nowrap tab strip below sets that width
       wide, and without this the whole console grows past the viewport and gets clipped
       by `overflow-hidden` — which reads as broken layout while `scrollWidth` stays
       clean, so it does not trip an overflow check. */
    <div className="panel relative min-w-0 overflow-hidden p-md sm:p-lg">
      {/* Segmented control. The active pill is a shared layout element, so switching
          modes slides it rather than repainting two buttons.

          The control is sized by its LABELS, not by the card: `w-fit` with a `max-w-full`
          ceiling. It used to be `w-full`, which stretched the track across the whole
          console and left two-thirds of it as dead rail to the right of "My GitHub" —
          a segmented control is a group of three choices, and drawing a container far
          wider than the choices reads as a fourth, empty one.

          The scroll ceiling stays: at 390px three labelled tabs do not fit, and letting
          them wrap breaks each label onto two lines inside its own pill. Dropping to
          icon-only would fit, but an icon-only control with no label is exactly the
          affordance people cannot read. */}
      <div className="mb-md flex w-fit min-w-0 max-w-full overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface-2)] p-2xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode("git")}
          className={tab(mode === "git")}
        >
          {mode === "git" && (
            <motion.span
              layoutId="console-tab"
              className="absolute inset-0 rounded-lg bg-[var(--accent-fill)]"
              transition={{ type: "spring", stiffness: 400, damping: 34 }}
            />
          )}
          <GitBranch className="relative h-4 w-4" />
          <span className="relative">Git URL</span>
        </button>
        <button
          type="button"
          disabled={busy || !localAccessAllowed}
          onClick={() => setMode("local")}
          title={
            localAccessAllowed
              ? undefined
              : "Disabled on this deployment: local-folder indexing would expose the server's filesystem to visitors. Use a Git URL, or self-host with CG_ALLOW_LOCAL_ACCESS=true."
          }
          className={tab(mode === "local")}
        >
          {mode === "local" && (
            <motion.span
              layoutId="console-tab"
              className="absolute inset-0 rounded-lg bg-[var(--accent-fill)]"
              transition={{ type: "spring", stiffness: 400, damping: 34 }}
            />
          )}
          <FolderOpen className="relative h-4 w-4" />
          <span className="relative">Local folder</span>
        </button>
        {me?.githubAuthEnabled && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setMode("github")}
            className={tab(mode === "github")}
          >
            {mode === "github" && (
              <motion.span
                layoutId="console-tab"
                className="absolute inset-0 rounded-lg bg-[var(--accent-fill)]"
                transition={{ type: "spring", stiffness: 400, damping: 34 }}
              />
            )}
            <GithubMark className="relative h-4 w-4" />
            <span className="relative">My GitHub</span>
          </button>
        )}
      </div>

      <form onSubmit={onSubmit}>
        {mode !== "github" && (
          <>
            <label htmlFor="cg-target" className="eyebrow mb-sm block">
              {mode === "git"
                ? "Repository URL"
                : "Absolute folder path (on the server)"}
            </label>
            <div className="flex flex-col gap-sm sm:flex-row">
              {mode === "git" ? (
                <input
                  id="cg-target"
                  type="url"
                  required
                  disabled={busy}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className={field}
                />
              ) : (
                <div className="flex flex-1 gap-sm">
                  <input
                    id="cg-target"
                    type="text"
                    required
                    disabled={busy}
                    value={pathVal}
                    onChange={(e) => setPathVal(e.target.value)}
                    placeholder="/Users/you/projects/my-app"
                    className={field}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setBrowsing(true)}
                    title="Browse for a folder"
                    className="flex min-h-14 shrink-0 cursor-pointer items-center gap-sm rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-md text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--line-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  >
                    <FolderSearch className="h-4 w-4" /> Browse
                  </button>
                </div>
              )}
              {/* Not disabled on an empty field: `required` already blocks submit
                  natively, and a permanently dimmed primary CTA is what made the
                  whole console read as inactive on first paint. */}
              {needsAuth ? (
                <a
                  href={`/api/auth/github?returnTo=${encodeURIComponent("/")}`}
                  className="group flex min-h-14 cursor-pointer items-center justify-center gap-sm rounded-xl bg-[var(--accent-fill)] px-lg py-md text-body font-semibold text-[var(--accent-on-fill)] transition-all duration-200 hover:bg-[var(--signal-400)] sm:px-lg"
                >
                  <GithubMark className="h-4 w-4" /> Sign in to index
                </a>
              ) : (
              <button
                type="submit"
                disabled={busy}
                className="group flex min-h-14 cursor-pointer items-center justify-center gap-sm rounded-xl bg-[var(--accent-fill)] px-lg py-md text-body font-semibold text-[var(--accent-on-fill)] transition-all duration-200 hover:bg-[var(--signal-400)] disabled:cursor-not-allowed disabled:opacity-40 sm:px-lg"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
                )}
                {busy ? "Indexing…" : "Index"}
              </button>
              )}
            </div>
          </>
        )}

        {mode === "github" && (
          <div>
            <span className="eyebrow mb-sm block">Your repositories</span>
            {!me?.user ? (
              <a
                href={`/api/auth/github?returnTo=${encodeURIComponent("/")}`}
                className="flex min-h-11 cursor-pointer items-center justify-center gap-sm rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-md py-sm text-meta text-[var(--text-secondary)] transition-colors duration-200 hover:border-[var(--line-strong)] hover:text-[var(--text-primary)]"
              >
                <GithubMark className="h-4 w-4" /> Sign in with GitHub to browse
                your repositories
              </a>
            ) : (
              <GithubReposPicker
                disabled={busy}
                onSelect={(htmlUrl) => startWithInput({ repoUrl: htmlUrl })}
              />
            )}
          </div>
        )}

        {mode === "git" && (
          <div className="mt-md flex flex-wrap items-center gap-sm">
            <span className="eyebrow mr-hair">Try</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={busy}
                onClick={() => setUrl(ex)}
                className="cursor-pointer rounded-md border border-[var(--line-soft)] px-sm py-2xs font-mono text-meta text-[var(--text-muted)] transition-colors duration-200 hover:border-[var(--signal-600)] hover:text-[var(--accent-text)] disabled:opacity-40"
              >
                {ex.replace("https://github.com/", "")}
              </button>
            ))}
          </div>
        )}

        {mode === "local" && (
          <p className="mt-md text-meta leading-relaxed text-[var(--text-muted)]">
            The path must exist on the machine running the app (self-hosted).
            Nothing is uploaded — it&apos;s read in place.
          </p>
        )}

        <AnimatePresence>
          {job && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="mt-md">
                <div className="mb-xs flex justify-between text-meta text-[var(--text-secondary)]">
                  <span>{job.message}</span>
                  <span className="tnum text-[var(--accent-text)]">
                    {job.progress}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-4)]">
                  <motion.div
                    className="h-full rounded-full bg-[var(--accent-fill)]"
                    animate={{ width: `${job.progress}%` }}
                    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <p className="mt-md break-all rounded-xl border border-[var(--coral-500)]/25 bg-[var(--coral-500)]/[0.08] px-md py-sm text-meta text-[var(--coral-text)]">
            {error}
          </p>
        )}
      </form>

      {repoId && job?.status === "done" && (
        <p className="mt-md text-meta text-[var(--accent-text)]">
          Done — opening report…
        </p>
      )}

      {browsing && (
        <FolderBrowser
          initialPath={pathVal.trim() || undefined}
          onClose={() => setBrowsing(false)}
          onSelect={(p) => {
            setPathVal(p);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}
