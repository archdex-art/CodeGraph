"use client";

import { CodeEditor } from "@/components/CodeEditor";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function EditorPage() {
  const repo = useRepo();
  return (
    <>
      <SectionHead
        eyebrow="Workspace"
        title="Editor"
        blurb="The cloned working tree, with git status, staging, commit and push. Edits happen here rather than in a copy you then have to reconcile."
      />
      {repo.hasWorkspace ? (
        // `visible` is always true now: the editor only mounts when its route is
        // active, where the old tab version stayed mounted and hidden behind CSS.
        <CodeEditor key={repo.id} repo={repo} visible />
      ) : (
        <Empty msg="No live workspace for this repository yet — re-index it to enable the built-in editor." />
      )}
    </>
  );
}
