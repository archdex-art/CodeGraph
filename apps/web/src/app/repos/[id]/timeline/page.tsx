"use client";

import { TimelineView } from "@/components/TimelineView";
import { SectionHead, useRepo } from "../repo-context";

export default function TimelinePage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="History"
        title="Timeline"
        blurb="How the Health Score and the graph moved across the repository's history, and which commits moved them."
      />
      <TimelineView repoId={repo.id} />
    </>
  );
}
