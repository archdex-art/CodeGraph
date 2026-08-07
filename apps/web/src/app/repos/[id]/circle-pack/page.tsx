"use client";

import { CirclePackView } from "@/components/CirclePackView";
import { GraphWorkbench } from "@/components/GraphWorkbench";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function CirclePackPage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Structure"
        title="Circle pack"
        blurb="The file tree drawn as nested area, so directory size and nesting depth are legible in one read rather than by expanding rows. Click a directory to zoom, a file to inspect its symbols."
      />
      {repo.tree && repo.tree.children && repo.tree.children.length > 0 ? (
        <GraphWorkbench repoId={repo.id} graph={repo.symbolGraph}>
          {(onSelect) => <CirclePackView tree={repo.tree!} onSelect={onSelect} />}
        </GraphWorkbench>
      ) : (
        <Empty msg="No file tree available." />
      )}
    </>
  );
}
