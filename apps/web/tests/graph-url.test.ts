import { describe, expect, it } from "vitest";
import {
  ALL_MODULES,
  graphHref,
  parseGraphState,
  serialiseGraphState,
  type GraphUrlState,
} from "@/lib/graph-url";

/**
 * The round-trip is the whole promise of a shareable graph: whatever the sender was
 * looking at has to survive a trip through an address bar and come back identical.
 * Everything else in these views is pixels; this is the part that silently breaks —
 * a file id is a path, so it carries slashes and dots through URL encoding, and a
 * lossy escape shows up as a link that opens the wrong module rather than as an
 * error anyone would notice.
 */
describe("graph url state", () => {
  const cases: GraphUrlState[] = [
    { open: null, focus: null },
    { open: ALL_MODULES, focus: null },
    { open: "apps/web", focus: "apps/web/src/components/NodeGraph.tsx" },
    // Characters that mean something to a query string. `+` is the one that bites:
    // decoded as a space by anything that treats the value as form data.
    { open: "packages", focus: "packages/x/a b+c&d.ts" },
  ];

  it.each(cases)("survives serialise → parse: %j", (state) => {
    expect(parseGraphState(serialiseGraphState("", state))).toEqual(state);
  });

  it("writes over its own params without disturbing anyone else's", () => {
    const qs = serialiseGraphState("tab=files&open=old&focus=old&line=42", {
      open: "src",
      focus: null,
    });
    expect(parseGraphState(qs)).toEqual({ open: "src", focus: null });
    expect(new URLSearchParams(qs).get("tab")).toBe("files");
    expect(new URLSearchParams(qs).get("line")).toBe("42");
  });

  it("reads a blank param as absent rather than as an empty id", () => {
    expect(parseGraphState("open=&focus=")).toEqual({ open: null, focus: null });
  });

  it("gives the default view a clean path, with no trailing ?", () => {
    expect(graphHref("/repos/1/network", "", { open: null, focus: null })).toBe("/repos/1/network");
    expect(graphHref("/repos/1/network", "", { open: "src", focus: null })).toBe(
      "/repos/1/network?open=src"
    );
  });
});
