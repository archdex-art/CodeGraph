"use client";

import { useSearchParams } from "next/navigation";
import { CodeEditor } from "@/components/CodeEditor";
import { Empty, SectionHead, useRepo } from "../repo-context";

export default function EditorPage() {
  const repo = useRepo();
  const params = useSearchParams();

  /**
   * `?file=…&line=…` is how a finding in the report opens here.
   *
   * The key is the raw query string rather than the file/line pair: clicking the same
   * finding twice produces an identical pair, and a component that compares only the
   * values treats the second arrival as "nothing changed" and does not re-reveal the
   * line. Next appends a cache-busting `t` on those links for exactly that reason, and
   * the whole string carries it.
   */
  const file = params.get("file");
  const lineParam = Number(params.get("line"));
  const openTarget =
    file && file.trim()
      ? {
          key: params.toString(),
          file,
          line: Number.isFinite(lineParam) && lineParam > 0 ? Math.floor(lineParam) : 1,
        }
      : null;

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
        <CodeEditor key={repo.id} repo={repo} visible openTarget={openTarget} />
      ) : (
        <Empty msg="No live workspace for this repository yet — re-index it to enable the built-in editor." />
      )}
    </>
  );
}
