"use client";

import { ArchitectureView } from "@/components/ArchitectureView";
import { GraphWorkbench } from "@/components/GraphWorkbench";
import { Empty, useRepo } from "../repo-context";

export default function ArchitecturePage() {
  const repo = useRepo();

  if (!repo.modules || repo.modules.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty msg="No module structure detected." />
      </div>
    );
  }

  return (
    <GraphWorkbench repoId={repo.id} graph={repo.symbolGraph} immersive>
      {(onSelect) => (
        <ArchitectureView
          modules={repo.modules!}
          viz={repo.viz}
          repoName={repo.name}
          onSelect={onSelect}
          immersive
        />
      )}
    </GraphWorkbench>
  );
}
