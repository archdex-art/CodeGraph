import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer";

/**
 * The walk runs over a CLONED, ATTACKER-AUTHORED tree, and git happily carries a
 * symlink with an absolute target. With `statSync` it saw the TARGET's type, so a
 * repository shipping `escape -> /etc` (or `secret.ts -> /etc/passwd`) had host files
 * walked, parsed, and written into the graph, findings and search index of a repo any
 * visitor of the shared public bucket can open. The sandbox walks in
 * `agents/executor.ts` and `remediate-engine/apply.ts` already refused symlinks; this
 * one did not.
 */

const trees: string[] = [];
afterEach(() => {
  for (const t of trees.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempTree(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  trees.push(dir);
  return dir;
}


describe("indexer walk — symlinks", () => {
  it("does not follow a symlinked DIRECTORY out of the repository", async () => {
    const outside = tempTree("cg-outside-");
    writeFileSync(path.join(outside, "leaked.ts"), "export const secret = 'leaked';\n");

    const root = tempTree("cg-symrepo-");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    symlinkSync(outside, path.join(root, "escape"));

    const tree = JSON.stringify((await indexRepo(root)).tree);
    expect(tree).toContain("src/a.ts");
    expect(tree).not.toContain("leaked.ts");
  });

  it("does not index a symlinked FILE pointing outside the repository", async () => {
    const outside = tempTree("cg-outside-file-");
    const target = path.join(outside, "passwd.ts");
    writeFileSync(target, "export const hostSecret = 'leaked';\n");

    const root = tempTree("cg-symrepo-file-");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    symlinkSync(target, path.join(root, "src", "linked.ts"));
    const tree = JSON.stringify((await indexRepo(root)).tree);
    expect(tree).toContain("src/a.ts");
    expect(tree).not.toContain("linked.ts");
  });
});
