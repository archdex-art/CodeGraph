"use client";

import { CodeIntelPanel } from "@/components/CodeIntelPanel";
import { SectionHead, useRepo } from "../repo-context";

export default function CodeIntelPage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Query"
        title="Code intelligence"
        blurb="Search the symbol graph: definitions, callers and callees, impact analysis, circular dependencies, dead code, and Graph-RAG context for an agent."
      />
      <CodeIntelPanel repoId={repo.id} graph={repo.symbolGraph} />
    </>
  );
}
