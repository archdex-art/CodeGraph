#!/usr/bin/env python3
"""Every workspace must declare `typecheck` and `test`.

WHY THIS EXISTS. The root scripts are:

    "typecheck": "npm run typecheck --workspaces --if-present"
    "test":      "vitest run"

`--if-present` means a workspace WITHOUT a `typecheck` script is silently skipped, and the run
still reports success. That is not a hypothetical: `apps/cli`, `packages/sandbox`, and
`packages/remediate-engine` were created, imported, and committed to a green `npm run
typecheck` while being entirely unchecked. A deliberate type error in `apps/cli/src/main.ts`
produced **0 errors** until this was found — and once the script was added, 14 real errors
appeared in code that had looked clean, including `--rule` with no value silently binding
undefined.

This is the third gate-with-a-blind-spot found on 2026-07-30, after the crashing ESLint config
and the three packages absent from `.dependency-cruiser.cjs`'s ALLOWED map. All three share one
shape: the gate reported success for work it never inspected. A gate that cannot tell you what
it skipped is a gate you cannot trust, so each now fails loudly on an unlisted member.

Run from the repository root; exits non-zero with the missing entries named.
"""

from __future__ import annotations

import json
import pathlib
import sys

REQUIRED = ("typecheck", "test")

# Workspaces legitimately exempt from a requirement, with the reason recorded here rather than
# by silent omission. Empty is the goal.
EXEMPT: dict[str, set[str]] = {}


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    manifests = sorted(
        [*root.glob("apps/*/package.json"), *root.glob("packages/*/package.json")]
    )
    if not manifests:
        print("check_workspace_scripts: FAILED — found no workspace manifests", file=sys.stderr)
        return 1

    problems: list[str] = []
    for manifest in manifests:
        ws = manifest.parent.relative_to(root).as_posix()
        try:
            scripts = (json.loads(manifest.read_text()).get("scripts") or {}).keys()
        except json.JSONDecodeError as e:
            problems.append(f"{ws}: package.json is not valid JSON ({e})")
            continue
        for required in REQUIRED:
            if required in scripts or required in EXEMPT.get(ws, set()):
                continue
            problems.append(
                f"{ws}: no `{required}` script — `--workspaces --if-present` SKIPS it silently, "
                f"so it is unverified while the root gate reports success"
            )

    # A `test` script the ROOT runner never reaches is still an unrun test suite. The root
    # `npm run test` is `vitest run`, which collects from `test.projects` in vitest.config.ts —
    # NOT from the workspace list. `apps/cli` had a test script, its own vitest.config.ts, and
    # 14 passing tests that `npm run test` did not execute, because it was absent from that
    # array. Same blind-spot shape as the other two, one layer over.
    vitest_config = (root / "vitest.config.ts").read_text()
    projects_start = vitest_config.find("projects:")
    projects_line = vitest_config[projects_start : vitest_config.find("]", projects_start)]
    for manifest in manifests:
        ws = manifest.parent.relative_to(root).as_posix()
        if not (manifest.parent / "vitest.config.ts").exists():
            continue
        group = f"{ws.split('/')[0]}/*"
        if ws in projects_line or group in projects_line:
            continue
        # apps/desktop is deliberately excluded from the root runner and runs in its own CI
        # job; the reasoning is recorded in vitest.config.ts.
        if ws == "apps/desktop":
            continue
        problems.append(
            f"{ws}: has a vitest.config.ts but is absent from `test.projects` in "
            f"vitest.config.ts — its tests never run from the repository root"
        )

    if problems:
        print(
            f"check_workspace_scripts: FAILED — {len(problems)} workspace(s) opt out of a gate "
            f"by omission",
            file=sys.stderr,
        )
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1

    print(f"check_workspace_scripts: OK — {len(manifests)} workspaces, all gated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
