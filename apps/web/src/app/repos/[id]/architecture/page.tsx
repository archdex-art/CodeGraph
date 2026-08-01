"use client";

import { ArchitectureView } from "@/components/ArchitectureView";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function ArchitecturePage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Structure"
        title="Architecture"
        blurb="Top-level modules layered by dependency direction, entry points on top. Arrow thickness is the import count; colour is the dominant language; a dot marks issues."
      />
      {repo.modules && repo.modules.nodes.length > 0 ? (
        <ArchitectureView modules={repo.modules} />
      ) : (
        <Empty msg="No module structure detected." />
      )}
    </>
  );
}
