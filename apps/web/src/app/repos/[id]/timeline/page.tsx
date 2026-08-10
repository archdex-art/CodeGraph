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
        blurb="What the graph measured at each indexed commit — import cycles, god files, fan-in, dependencies, test ratio — and, beside those facts, the scores that only judge them."
      />
      <TimelineView repoId={repo.id} />
    </>
  );
}
