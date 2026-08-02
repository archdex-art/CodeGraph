import type ts from "typescript";
import type { SymbolKind } from "./symbol";

/**
 * The extractor contract, shared by `extractors.ts` and `ast-extractor.ts`.
 *
 * Extracted into its own module to break a real import cycle. `extractors.ts`
 * imports `astTsExtractor` (a value) from `ast-extractor.ts`, while
 * `ast-extractor.ts` imported these six types back from `extractors.ts` — so the
 * two files formed a cycle that `no-circular` reports and that has been carried in
 * the known-violations baseline since v1. It survived the LLD §13.2 move only
 * because the baseline keyed on the old `apps/web/src/lib/codeintel/*` paths.
 *
 * Re-baselining it under the new paths would have been the cheap option. This is
 * the cheap-and-correct one: the dependency was type-only in one direction, so
 * relocating the types removes the cycle outright with no runtime change at all
 * (`verbatimModuleSyntax` erases type imports).
 */

/** A raw symbol before graph-level resolution (fanIn/fanOut/edges added later). */
export interface RawSymbol {
  name: string;
  kind: SymbolKind;
  line: number; // 1-indexed
  endLine: number;
  signature: string;
  doc: string | null;
  exported: boolean;
  container: string | null; // local container name (class) for nesting
}

export interface RawReference {
  name: string;
  /**
   * 1-indexed, the line the call occurs on — lets `graph.ts` attribute it to the
   * enclosing function/method instead of guessing at the file level.
   */
  line: number;
  /** Set by type-aware extractors to bypass heuristic resolution. */
  resolvedTargetId?: string;
}

/**
 * A local import binding: `localName` resolves to `importedName` exported from
 * `modulePath` (as written in source — relative paths are resolved against the
 * file's own location in `graph.ts`; bare specifiers, e.g. "react", are left
 * unresolved and fall through to same-file/global name search).
 */
export interface RawImport {
  localName: string;
  importedName: string; // "*" for `import * as ns from "..."` (namespace)
  modulePath: string;
}

export interface ExtractContext {
  text: string;
  relPath: string;
  /**
   * The key by which `program` knows this file - absolute, because module resolution
   * normalises against the current directory. `relPath` stays repo-relative for symbol ids;
   * these are deliberately two different strings and conflating them is what silently
   * disabled type-aware resolution.
   */
  programPath?: string;
  /**
   * Present only when the caller built a TypeScript program, which is what lets
   * the AST extractor resolve a call to a declaration instead of matching on name.
   *
   * Typed as `ts.Program` rather than the `any` it carried before the §13.2 move.
   * `any` here was load-bearing in the wrong direction: it silently accepted any
   * value at every call site while disabling checking on every `program.*` access
   * inside the extractor — the one place precision matters, since a wrong
   * assumption about this object is exactly how a resolution bug hides.
   */
  program?: ts.Program;
}

export interface LanguageExtractor {
  language: string;
  exts: string[];
  extract(ctx: ExtractContext): ExtractResult;
}

export interface ExtractResult {
  symbols: RawSymbol[];
  references: RawReference[];
  imports: RawImport[];
}
