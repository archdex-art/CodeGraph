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
SKIP_DIR_NAMES = {"node_modules", ".next", "dist", "build", "out", "coverage", ".git"}


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
        owner_prefixes=("packages/observability/src/",),
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

#: A banned token inside a comment is documentation, not a call. `fixers.ts`
#: explains the brace-less-block codemod hazard (REVIEW B1) using literal
#: `console.log` examples, and that comment records an outage lesson worth
#: keeping (CLAUDE.md §5). Only whole-line comments are skipped, so a trailing
#: `doThing(); // console.log(x)` is still reported.
COMMENT_LINE_RE = re.compile(r"^\s*(//|/\*|\*|#)")


def is_comment_line(line: str) -> bool:
    return COMMENT_LINE_RE.match(line) is not None


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
            files.append(path)
    return sorted(files)


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
