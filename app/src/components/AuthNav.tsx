"use client";

import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { fetchMe, signOut } from "@/lib/api";
import { GithubMark } from "@/components/GithubMark";

export function AuthNav() {
  const [me, setMe] = useState<{ githubAuthEnabled: boolean; user: { login: string; name: string | null; avatarUrl: string } | null } | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe({ githubAuthEnabled: false, user: null }));
  }, []);

  if (!me || !me.githubAuthEnabled) return null; // not configured on this deployment — stay out of the way entirely

  if (!me.user) {
    return (
      <a
        href={`/api/auth/github?returnTo=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname : "/")}`}
        className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors"
      >
        <GithubMark className="w-4 h-4" /> Sign in with GitHub
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- avatars are arbitrary external GitHub URLs */}
      <img src={me.user.avatarUrl} alt="" className="w-6 h-6 rounded-full border border-white/10" />
      <span className="text-gray-300">{me.user.login}</span>
      <button
        onClick={async () => {
          await signOut();
          setMe({ githubAuthEnabled: true, user: null });
        }}
        title="Sign out"
        className="text-gray-500 hover:text-white transition-colors"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  );
}
