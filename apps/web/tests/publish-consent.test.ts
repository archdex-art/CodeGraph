import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review C4: "Your source is never modified" — but the executor pushed a branch to the user's
 * real repo.
 *
 * `AgentSwarm.tsx` makes that promise to the user. `executor.ts` did `git push -u origin
 * <branch>` and opened a PR as a SIDE EFFECT of asking for a fix. Sandbox purity held for the
 * working copy and not for the remote, which is the half that is hard to undo.
 *
 * These are SOURCE-LEVEL assertions rather than behavioural ones, deliberately. The behaviour
 * under test is the absence of a network mutation, and a test that proved it by actually
 * pushing to a repository would be the bug. Asserting that no route can construct the consent
 * object is the strongest check available without a live remote, and it fails loudly if
 * someone reintroduces the path.
 */

const root = path.join(process.cwd(), "apps/web/src");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("publishing requires explicit consent (review C4)", () => {
  it("gates every remote mutation behind publish?.confirmed", () => {
    const executor = read("lib/agents/executor.ts");
    // The push block must be inside the consent check.
    const gate = executor.indexOf("publish?.confirmed");
    const push = executor.indexOf('"push", "-u", "origin"');
    expect(gate).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(gate);
  });

  it("does not treat possession of a token as consent", () => {
    // The old condition was `pr && githubToken && ...`. Having a credential is not permission
    // to use it, and that conflation is what made the UI's promise false.
    const executor = read("lib/agents/executor.ts");
    expect(executor).not.toMatch(/if \(pr && githubToken/);
  });

  it("has no route that constructs a PublishConsent, so nothing publishes as shipped", () => {
    // The capability exists and is unreachable. This is what makes AgentSwarm's claim TRUE
    // today, as opposed to aspirational.
    const routes = [
      "app/api/repos/[id]/fix/route.ts",
      "app/api/findings/[id]/fix/route.ts",
    ].map(read);
    for (const src of routes) {
      expect(src).not.toMatch(/confirmed\s*:\s*true/);
    }
  });

  it("no longer passes a publish credential into the executor", () => {
    // A token threaded through an argument nobody reads is a trap: the next reader assumes it
    // is used. Both fix routes stopped passing it when publishing became opt-in.
    for (const rel of ["app/api/repos/[id]/fix/route.ts", "app/api/findings/[id]/fix/route.ts"]) {
      expect(read(rel)).not.toMatch(/publishCredential/);
    }
  });

  it("still keeps the UI's promise verbatim, so the claim and the code agree", () => {
    // If this string is ever changed, the test above should be revisited alongside it — the
    // pairing is the point.
    expect(read("components/AgentSwarm.tsx")).toMatch(/never modified/i);
  });
});
