import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsGrants } from "./fs-grants";

/**
 * Containment for IPC filesystem access.
 *
 * `FileSystemService` passed `request.path` from an IPC message straight to `fs.readFile`. The
 * `fs:read` permission answers "may the renderer touch the disk", never "which file", so any
 * renderer holding it could read anything the user could. Found by CodeGraph's own taint
 * analysis on this repository - the only sink still reporting `tainted` once guard recognition
 * landed.
 */
let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cg-grant-"));
  outside = mkdtempSync(path.join(tmpdir(), "cg-outside-"));
  writeFileSync(path.join(root, "ok.txt"), "in");
  writeFileSync(path.join(outside, "secret.txt"), "out");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("FsGrants", () => {
  it("denies everything until the user grants a directory", () => {
    const g = new FsGrants();
    // The default is deny. A fresh main process must not be able to read the disk.
    expect(g.resolveWithinGrant(path.join(root, "ok.txt"))).toBeNull();
  });

  it("allows a file inside a granted root", () => {
    const g = new FsGrants();
    g.grant(root);
    expect(g.resolveWithinGrant(path.join(root, "ok.txt"))).not.toBeNull();
  });

  it("denies traversal out of a granted root", () => {
    const g = new FsGrants();
    g.grant(root);
    expect(g.resolveWithinGrant(path.join(root, "..", "..", "etc", "passwd"))).toBeNull();
    expect(g.resolveWithinGrant(path.join(outside, "secret.txt"))).toBeNull();
  });

  it("denies a symlink inside the root that points outside it", () => {
    // The lexical check passes here - the path really is under the root - so only the realpath
    // probe catches it. This is the case a naive `startsWith` guard silently allows.
    const g = new FsGrants();
    g.grant(root);
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    expect(g.resolveWithinGrant(path.join(root, "link.txt"))).toBeNull();
  });

  it("allows a not-yet-existing file inside the root, so writes work", () => {
    // `realpathSync` throws on a missing path; the probe walks to the nearest existing
    // ancestor. Without that, every create would be denied.
    const g = new FsGrants();
    g.grant(root);
    mkdirSync(path.join(root, "sub"));
    expect(g.resolveWithinGrant(path.join(root, "sub", "new.txt"))).not.toBeNull();
  });

  it("stops allowing a root once revoked", () => {
    const g = new FsGrants();
    g.grant(root);
    g.revoke(root);
    expect(g.resolveWithinGrant(path.join(root, "ok.txt"))).toBeNull();
  });

  it("rejects an empty path rather than resolving it to the process cwd", () => {
    const g = new FsGrants();
    g.grant(root);
    expect(g.resolveWithinGrant("")).toBeNull();
  });

  it("denies an absolute path outside the grant, rather than reinterpreting it", () => {
    /**
     * The one place this deliberately differs from `@codegraph/fsx.resolveSafe`, which takes a
     * workspace-RELATIVE path and strips leading slashes - turning `"/etc/passwd"` into
     * `<root>/etc/passwd`, inside the root and allowed. Correct there, wrong here: an IPC
     * message carries an absolute path, and rewriting it would answer a different question
     * than the renderer asked. Pinned so nobody "aligns" the two.
     */
    const g = new FsGrants();
    g.grant(root);
    expect(g.resolveWithinGrant("/etc/passwd")).toBeNull();
  });
});
