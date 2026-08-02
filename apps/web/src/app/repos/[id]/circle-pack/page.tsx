"use client";

import { CirclePackView } from "@/components/CirclePackView";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function CirclePackPage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Structure"
        title="Circle pack"
        blurb="The file tree drawn as nested area, so directory size and nesting depth are legible in one read rather than by expanding rows."
      />
      {repo.tree && repo.tree.children && repo.tree.children.length > 0 ? (
        <CirclePackView tree={repo.tree} />
      ) : (
        <Empty msg="No file tree available." />
      )}
    </>
  );
}
