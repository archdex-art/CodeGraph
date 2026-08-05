#!/usr/bin/env python3
"""Enforce the module-boundary bans that a type checker cannot express.

`dependency-cruiser` covers layering and imports (HLD §6.1). It cannot see
*property access*, so the two rules below need their own gate:

  - `process.env` is read only inside `@codegraph/config` (LLD §10.3)
  - `console.*` is called only inside `@codegraph/observability` (HLD §14)

Written in Python rather than as a `grep`/`rg` one-liner for two reasons: the
exclusions below need to be stated and justified rather than crammed into glob
flags, and at least one macOS `grep` in the wild mishandles BRE alternation
badly enough to report matches on lines that do not contain the pattern at all,
which makes a shell one-liner an untrustworthy gate.

Usage:  python3 scripts/check_boundaries.py
Exit:   0 clean, 1 with a file:line list of violations.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Directories whose *production* sources are subject to the bans.
SCAN_ROOTS = ("apps", "packages")

SOURCE_SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}

# Never scanned: build output, dependencies, and generated types.
SKIP_DIR_NAMES = {"node_modules", ".next", "dist", "dist-bin", "build", "out", "coverage", ".git"}


@dataclass(frozen=True)
class Ban:
    name: str
    pattern: re.Pattern[str]
    # Path fragments (posix, relative to repo root) that are allowed to match.
    owner_prefixes: tuple[str, ...]
    reason: str


BANS = (
    Ban(
        name="process.env",
        pattern=re.compile(r"\bprocess\.env\b"),
        # One owner, and it stays that way. The Electron shell used to hold the only
        # other exemption here; apps/desktop has since been removed from the repo, so
        # the ban is now absolute outside config's own source.
        owner_prefixes=("packages/config/src/",),
        reason=(
            "Read configuration from @codegraph/config instead. It validates at boot and "
            "reports every invalid variable at once; scattered inline fallbacks make the "
            "effective configuration unknowable without grepping (LLD §10.3). For a child "
            "process that needs the whole inherited environment, use config's childEnv()."
        ),
    ),
    Ban(
        name="console.*",
        pattern=re.compile(r"\bconsole\.(log|warn|error|info|debug|trace)\s*\("),
        owner_prefixes=(
            "packages/observability/src/",
            # Developer-facing build tooling whose entire
            # output contract is the terminal it is run from. It never ships — the
            # Dockerfile invokes it in the builder stage and copies only `dist/`. Routing
            # it through the structured logger would put the build log somewhere nobody
            # looking at a failed build would think to look.
            "apps/worker/build.mjs",
        ),
        reason=(
            "Use the logger from @codegraph/observability. Unstructured console output "
            "carries no runId/jobId/stage, so a failure cannot be attributed to a stage "
            "(HLD §14, G7)."
        ),
    ),
)

# ---------------------------------------------------------------------------
# Exclusions, each with a reason. A gate whose exclusions are not justified is
# a gate that quietly stops meaning anything.
# ---------------------------------------------------------------------------

#: Tests legitimately drive env-dependent behaviour by mutating `process.env`
#: (the `Secure`-cookie and rate-limit-keying regression suites do exactly
#: this), and `config` reads live precisely so they still work. Rewriting them
#: to inject config would delete the coverage that proves the real
#: environment→behaviour path, so tests are out of scope for the env ban.
TEST_PATH_MARKERS = ("/tests/", "/test/", ".test.", ".spec.")


def is_test_path(rel_posix: str) -> bool:
    return any(marker in rel_posix for marker in TEST_PATH_MARKERS)


#: `apps/web/data/` is runtime state, not source: `data/workspaces/` holds full
#: git clones of every repository the operator has analysed. Those clones
#: contain other projects' code, which the bans have no authority over, and
#: scanning them made this gate report 54 violations against files CodeGraph
#: does not own (reproduced: a cloned copy of CodeGraph itself, so the numbers
#: even looked plausible). The path is gitignored, so CI's fresh checkout never
#: had it and only a developer who had actually used the app would ever see the
#: failure — the worst kind, because it trains people to ignore the gate.
RUNTIME_STATE_MARKERS = ("apps/web/data/",)


def is_runtime_state(rel_posix: str) -> bool:
    return any(rel_posix.startswith(marker) for marker in RUNTIME_STATE_MARKERS)


#: Test-runner configuration is not a production source: a vitest config reads
#: the environment to decide how the RUNNER behaves, which is how a runner is
#: meant to be configured. The docstring's scope is "production sources", so
#: these are outside it — stated here rather than left to fail and be worked
#: around. (`playwright.config.ts` was in this list for the Electron e2e suite,
#: removed with apps/desktop.)
TOOLING_CONFIG_NAMES = ("vitest.config.ts", "vitest.workspace.ts")


def is_tooling_config(rel_posix: str) -> bool:
    return rel_posix.rsplit("/", 1)[-1] in TOOLING_CONFIG_NAMES


def iter_source_files() -> list[Path]:
    files: list[Path] = []
    for root_name in SCAN_ROOTS:
        root = REPO_ROOT / root_name
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
                continue
            if any(part in SKIP_DIR_NAMES for part in path.parts):
                continue
            rel = path.relative_to(REPO_ROOT).as_posix()
            if is_runtime_state(rel) or is_tooling_config(rel):
                continue
            files.append(path)
    return sorted(files)


#: A banned token inside a comment is documentation, not a call. `fixers.ts`
#: explains the brace-less-block codemod hazard (REVIEW B1) using literal
#: `console.log` examples, and that comment records an outage lesson worth
#: keeping (CLAUDE.md §5). Only whole-line comments are skipped, so a trailing
#: `doThing(); // console.log(x)` is still reported.
COMMENT_LINE_RE = re.compile(r"^\s*(//|/\*|\*|#)")


def is_comment_line(line: str) -> bool:
    return COMMENT_LINE_RE.match(line) is not None


def main() -> int:
    violations: list[tuple[Ban, str, int, str]] = []

    for path in iter_source_files():
        rel = path.relative_to(REPO_ROOT).as_posix()
        if is_test_path(rel):
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        for ban in BANS:
            if any(rel.startswith(prefix) for prefix in ban.owner_prefixes):
                continue
            for lineno, line in enumerate(lines, start=1):
                if is_comment_line(line):
                    continue
                if ban.pattern.search(line):
                    violations.append((ban, rel, lineno, line.strip()))

    if not violations:
        scanned = len(iter_source_files())
        print(f"check_boundaries: OK — {scanned} source files, 0 violations")
        for ban in BANS:
            print(f"  {ban.name:<12} confined to {', '.join(ban.owner_prefixes)}")
        return 0

    by_ban: dict[str, list[tuple[str, int, str]]] = {}
    for ban, rel, lineno, text in violations:
        by_ban.setdefault(ban.name, []).append((rel, lineno, text))

    print(f"check_boundaries: FAILED — {len(violations)} violation(s)\n", file=sys.stderr)
    for ban in BANS:
        found = by_ban.get(ban.name)
        if not found:
            continue
        print(f"{ban.name} is confined to {', '.join(ban.owner_prefixes)}", file=sys.stderr)
        print(f"  {ban.reason}\n", file=sys.stderr)
        for rel, lineno, text in found:
            print(f"  {rel}:{lineno}: {text}", file=sys.stderr)
        print("", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
