import ts from "typescript";
import type { FixCandidate } from "@codegraph/verify";
import type { FileEdit } from "./types";

/**
 * Bridge from the line-based `FileEdit` the fixers emit to the `FixCandidate` the gates take.
 *
 * WHY A BRIDGE AND NOT A CONVERSION. LLD §7.1's `TextEdit` is range-based and that is where
 * fixers are going (review B1); today they still return line numbers. Gate 1 only needs the
 * SET OF FILES touched — it re-reads each from the sandbox and parses it — so one placeholder
 * range per file is sufficient and honest about what it is. Inventing precise ranges from line
 * numbers here would fabricate provenance the fixers never produced.
 *
 * THE FAILURE THIS PREVENTS: `syntaxGate` derives its file list from `candidate.edits`, so a
 * candidate with `edits: []` returns "passed — no files edited" WITHOUT PARSING ANYTHING. A
 * vacuous gate reporting success is the exact overclaim the four gates exist to remove, and it
 * is silent. Every caller must build its candidate through here.
 */
export function candidateFor(
  edits: readonly FileEdit[],
  providerId: string
): FixCandidate {
  const files = [...new Set(edits.map((e) => e.file))];
  return {
    findingId: "" as FixCandidate["findingId"],
    providerId,
    edits: files.map((file) => ({
      range: { file, startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
      newText: "",
    })),
    explanation: `${edits.length} deterministic edit(s) across ${files.length} file(s)`,
    confidence: 1,
  };
}

/**
 * Gate 1's parse check — a REAL parse for TypeScript and JavaScript.
 *
 * `@codegraph/verify` takes `parse` injected so it depends on no language plugin. This package
 * already depends on `typescript` (the AST guards need it for review B1), so the honest check
 * is available here without adding anything: `createSourceFile` and read `parseDiagnostics`.
 *
 * WHAT THIS REPLACES. The web executor injected a hand-rolled bracket-balance scanner, with a
 * comment conceding it was "deliberately NOT a full parser" pending P5's `lang-typescript`.
 * Balance is a proxy: it catches an unclosed brace and misses everything else a parser
 * catches — `if (x) else y`, a stray `)`, a keyword where an expression belongs. Since a fixer
 * deleting a line is most likely to produce exactly those, the proxy was weakest where gate 1
 * matters most.
 *
 * Non-JS/TS files return ok. That is not an oversight: Python is fixable (`print` removal) and
 * there is no Python parser in this process, so claiming a parse for it would be the same class
 * of fiction. Gate 1's `reason` records which files were actually re-parsed.
 */
export function parseCheck(file: string, text: string): { ok: boolean; error?: string } {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return { ok: true };

  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  // Internal, and the only way to see that the parse was clean: TS returns a partial tree for
  // broken input rather than throwing.
  const diagnostics = (
    source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;

  if (!diagnostics || diagnostics.length === 0) return { ok: true };

  const first = diagnostics[0]!;
  const { line } = source.getLineAndCharacterOfPosition(first.start ?? 0);
  const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
  return { ok: false, error: `${file}:${line + 1} ${message}` };
}
