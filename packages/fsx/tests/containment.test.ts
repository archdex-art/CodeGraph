import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePathError, openWorkspace, resolveSafe } from "../src/index";

/**
 * Containment is the whole reason this package exists: a workspace root is a
 * boundary around a *cloned, attacker-authored* repository, and the process can
 * read and write anywhere the host user can. Every test below is a real
 * filesystem scenario rather than a mocked assertion — the failure mode being
 * guarded is a path that escapes at the OS level while looking fine lexically,
 * and only a real symlink reproduces that.
 */

const roots: string[] = [];

function freshWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cg-fsx-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("lexical traversal", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });

  it("allows a normal nested path", () => {
    expect(() => resolveSafe(root, "src/index.ts")).not.toThrow();
  });

  it("rejects ../ escapes", () => {
    expect(() => resolveSafe(root, "../../../etc/passwd")).toThrow(WorkspacePathError);
  });

  it("rejects an escape hidden mid-path", () => {
    expect(() => resolveSafe(root, "src/../../outside.txt")).toThrow(WorkspacePathError);
  });

  it("treats a leading slash as workspace-relative, not absolute", () => {
    // `/etc/passwd` must resolve INSIDE the root, not at the filesystem root.
    const full = resolveSafe(root, "/etc/passwd");
    expect(full.startsWith(root + path.sep)).toBe(true);
  });

  it("normalises an empty path to the root itself", () => {
    expect(resolveSafe(root, "")).toBe(path.resolve(root));
  });

  it("permits a path whose target does not exist yet (create/write)", () => {
    // A write to a new file must be allowed; only the containment of its
    // nearest existing ancestor can be checked.
    expect(() => resolveSafe(root, "src/brand/new/file.ts")).not.toThrow();
  });
});

describe("symlink escapes — what a lexical check alone would miss", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = freshWorkspace();
    outside = mkdtempSync(path.join(tmpdir(), "cg-outside-"));
    roots.push(outside);
    writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET\n", "utf8");
  });

  it("rejects a symlinked FILE pointing outside the root", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    expect(() => resolveSafe(root, "leak.txt")).toThrow(WorkspacePathError);
  });

  it("rejects a symlinked ANCESTOR DIRECTORY pointing outside the root", () => {
    // The nastier case: `escape/secret.txt` is lexically inside the root, and
    // only realpathing an ancestor reveals that it is not.
    symlinkSync(outside, path.join(root, "escape"));
    expect(() => resolveSafe(root, "escape/secret.txt")).toThrow(WorkspacePathError);
  });

  it("rejects reading through an escaping symlink via the handle", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    const ws = openWorkspace(root);
    expect(() => ws.read("leak.txt")).toThrow(WorkspacePathError);
    expect(() => ws.readBytes("leak.txt")).toThrow(WorkspacePathError);
  });

  it("refuses to WRITE through an escaping symlink", () => {
    // Reads leak; writes corrupt. Both must be refused.
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    const ws = openWorkspace(root);
    expect(() => ws.write("leak.txt", "overwritten")).toThrow(WorkspacePathError);
    expect(() => ws.writeBytes("leak.txt", new Uint8Array([1, 2]))).toThrow(WorkspacePathError);
  });

  it("still ALLOWS an in-repo symlink that resolves inside the root", () => {
    // The counterweight. A cloned repository may legitimately contain symlinks,
    // and v1 permits them so long as the real path stays contained. Rejecting
    // these (e.g. with O_NOFOLLOW) would be a behaviour change, not a fix.
    symlinkSync(path.join(root, "src", "index.ts"), path.join(root, "alias.ts"));
    const ws = openWorkspace(root);
    expect(ws.read("alias.ts").content).toContain("export const x");
  });

  it("rejects a DANGLING symlink pointing outside the root", () => {
    // The escape the ancestor-walk missed. `realpathSync` fails identically for
    // "does not exist" and "is a dangling symlink", so the walk fell back to the
    // parent — the root itself — and passed. But `open(2)` FOLLOWS a dangling
    // symlink and CREATES the file at its target, so a write through this link
    // lands outside the workspace.
    symlinkSync(path.join(outside, "planted.txt"), path.join(root, "innocent.txt"));
    expect(() => resolveSafe(root, "innocent.txt")).toThrow(WorkspacePathError);
    const ws = openWorkspace(root);
    expect(() => ws.write("innocent.txt", "pwned")).toThrow(WorkspacePathError);
    expect(existsSync(path.join(outside, "planted.txt"))).toBe(false);
  });

  it("rejects a dangling symlinked ANCESTOR pointing outside the root", () => {
    symlinkSync(path.join(outside, "nope"), path.join(root, "gate"));
    expect(() => resolveSafe(root, "gate/child.txt")).toThrow(WorkspacePathError);
  });

  it("rejects a symlink CYCLE instead of looping or passing", () => {
    symlinkSync(path.join(root, "b"), path.join(root, "a"));
    symlinkSync(path.join(root, "a"), path.join(root, "b"));
    expect(() => resolveSafe(root, "a")).toThrow(WorkspacePathError);
  });

  it("still ALLOWS creating a NEW file that does not exist yet", () => {
    // The counterweight to the dangling-symlink rejection: an absent path with no
    // symlink in it is a normal create, not an escape.
    const ws = openWorkspace(root);
    expect(() => ws.write("src/brand-new.ts", "export const y = 2;\n")).not.toThrow();
    expect(existsSync(path.join(root, "src", "brand-new.ts"))).toBe(true);
  });
});

describe("the handle re-validates on every access", () => {
  it("refuses a path that became an escape after an earlier successful access", () => {
    // This is the TOCTOU shape LLD §10.1 is about. A handle cannot hand out a
    // path to be reused later, so the second access is checked afresh and
    // refused — whereas a cached `resolveSafe` result would have been used
    // unchecked.
    const root = freshWorkspace();
    const outside = mkdtempSync(path.join(tmpdir(), "cg-outside-"));
    roots.push(outside);
    writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET\n", "utf8");

    const ws = openWorkspace(root);
    writeFileSync(path.join(root, "swap.txt"), "benign\n", "utf8");
    expect(ws.read("swap.txt").content).toBe("benign\n");

    // The file is replaced by a symlink out of the workspace.
    rmSync(path.join(root, "swap.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "swap.txt"));

    expect(() => ws.read("swap.txt")).toThrow(WorkspacePathError);
  });

  it("exposes its root but takes only relative paths", () => {
    const root = freshWorkspace();
    const ws = openWorkspace(root);
    expect(ws.root).toBe(root);
    // An absolute path is interpreted relative to the root, never honoured as
    // absolute (see the leading-slash test above).
    expect(() => ws.read("/etc/passwd")).toThrow();
  });

  it("holds no state that one caller could change for another", () => {
    // Two handles on the same root are independent objects; nothing is cached
    // between them (the hazard behind review item B4).
    const root = freshWorkspace();
    const a = openWorkspace(root);
    const b = openWorkspace(root);
    expect(a).not.toBe(b);
    expect(a.list(".").map((e) => e.name)).toEqual(b.list(".").map((e) => e.name));
  });
});

describe("size caps", () => {
  it("rejects a text write over the cap", () => {
    const root = freshWorkspace();
    const ws = openWorkspace(root);
    expect(() => ws.write("big.txt", "x".repeat(8_000_001))).toThrow(WorkspacePathError);
  });

  it("rejects a byte write over the cap", () => {
    // Enforced in fsx, not only at the route, so a second caller cannot bypass
    // it (F011 — there was no write cap at all before).
    const root = freshWorkspace();
    const ws = openWorkspace(root);
    expect(() => ws.writeBytes("big.bin", new Uint8Array(8_000_001))).toThrow(WorkspacePathError);
  });

  it("accepts a write at exactly the cap", () => {
    const root = freshWorkspace();
    const ws = openWorkspace(root);
    expect(() => ws.writeBytes("at-cap.bin", new Uint8Array(8_000_000))).not.toThrow();
  });
});
