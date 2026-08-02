"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Lock, Loader2, ArrowUpRight, Star } from "lucide-react";
import { fetchGithubRepoPage, type GithubRepoListing } from "@/lib/api";

export function GithubReposPicker({ onSelect, disabled }: { onSelect: (htmlUrl: string) => void; disabled?: boolean }) {
  const [repos, setRepos] = useState<GithubRepoListing[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchGithubRepoPage(1)
      .then((r) => {
        setRepos(r.repos);
        setHasMore(r.hasMore);
        setPage(1);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load repos"))
      .finally(() => setLoading(false));
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await fetchGithubRepoPage(page + 1);
      setRepos((prev) => [...prev, ...r.repos]);
      setHasMore(r.hasMore);
      setPage((p) => p + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more repos");
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q));
  }, [repos, query]);

  return (
    <div className="rounded-lg border border-white/10 bg-[#0a0a0a] overflow-hidden">
      <div className="p-sm border-b border-white/10">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-600 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your repositories…"
            className="w-full bg-transparent pl-xl pr-sm py-sm text-meta text-white placeholder-gray-600 focus:outline-none"
          />
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-sm text-meta text-gray-500 p-md">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your repositories…
          </div>
        ) : error ? (
          <p className="text-meta text-rose-400 px-md py-md">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-md py-lg text-meta text-gray-600 text-center">{query ? "No repositories match." : "No repositories found."}</p>
        ) : (
          <ul>
            {filtered.map((r) => (
              <li key={r.fullName}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(r.htmlUrl)}
                  className="w-full text-left flex items-center gap-sm px-sm py-sm hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-xs">
                      <span className="text-meta text-white truncate">{r.fullName}</span>
                      {r.private && <Lock className="w-3 h-3 text-amber-400 shrink-0" />}
                    </div>
                    {r.description && <p className="text-meta text-gray-500 truncate mt-hair">{r.description}</p>}
                  </div>
                  <div className="flex items-center gap-sm shrink-0 text-meta text-gray-600">
                    {r.language && <span>{r.language}</span>}
                    {r.stargazersCount > 0 && (
                      <span className="flex items-center gap-hair">
                        <Star className="w-3 h-3" />
                        {r.stargazersCount}
                      </span>
                    )}
                    <ArrowUpRight className="w-3.5 h-3.5 text-gray-700" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading && !error && hasMore && !query && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full text-center text-meta text-gray-500 hover:text-white py-sm border-t border-white/5 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
