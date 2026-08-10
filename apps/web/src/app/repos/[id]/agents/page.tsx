"use client";

import { AgentSwarm } from "@/components/AgentSwarm";
import { SectionHead, useRepo } from "../repo-context";

export default function AgentsPage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Remediation"
        title="Agent swarm"
        blurb="Deterministic specialists argue findings out among themselves, a critic challenges them, a judge ranks what survives. Any finding can then be turned into a fix proved against your own test suite."
      />
      <AgentSwarm repoId={repo.id} hasWorkspace={repo.hasWorkspace} issues={repo.issues} />
    </>
  );
}
