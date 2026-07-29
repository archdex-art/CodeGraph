import { createHash } from "node:crypto";

/**
 * Location-independent finding identity (LLD §2.1, HLD §11.2).
 *
 * This one function is what makes suppression, baselines, "new since main", and
 * trend lines possible, so its output is a persisted contract: a stored
 * suppression row is a fingerprint, and changing how this is computed silently
 * un-suppresses everything a user has already dismissed. Treat the algorithm as
 * frozen. `tests/fingerprint.test.ts` pins exact output values for that reason —
 * if you change the algorithm those tests are SUPPOSED to fail, and the change
 * needs a migration, not a test update.
 */

/** Deliberately excludes line, column, and file path — see `fingerprint`. */
export interface FingerprintInput {
  /** Namespaced rule identity, e.g. "js/sql-injection". */
  readonly ruleId: string;
  /** Enclosing symbol's fully-qualified name, or the file's basename if none. */
  readonly scope: string;
  /** Output of `normalizeSnippet`. */
  readonly normalizedSnippet: string;
}

/**
 * Sentinels for elided literals. A control character is used rather than a
 * readable token like `$STR$` because `$` is a legal JavaScript identifier
 * character, so a readable sentinel could collide with real source text and let
 * two genuinely different snippets fingerprint alike.
 */
const STRING_SENTINEL = "\u0001s";
const NUMBER_SENTINEL = "\u0001n";

/** Single/double/backtick strings, honouring backslash escapes. */
const STRING_LITERAL_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** Hex first — otherwise the decimal branch matches the `0` of `0xFF`. */
const NUMBER_LITERAL_RE = /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

const WHITESPACE_RUN_RE = /\s+/g;

/**
 * Drops a space when the character on either side is not part of an identifier.
 *
 * Collapsing whitespace runs alone is not enough to survive a formatter.
 * `const x = "a";` and `const x = "a" ;` differ only in a space beside `;`, so
 * running Prettier over a file would change fingerprints and silently discard
 * every suppression the user had recorded against it.
 *
 * The identifier-adjacency condition is what keeps this safe: the space in
 * `return x` is preserved (both sides are identifier characters) so it cannot
 * collide with `returnx`, while spaces around `=`, `(`, `,`, `;` and friends are
 * dropped. Cheaper and more predictable than tokenising, and it fails in the
 * direction of keeping distinctions rather than erasing them.
 */
const SPACE_BESIDE_PUNCTUATION_RE = /(?<![A-Za-z0-9_$]) | (?![A-Za-z0-9_$])/g;

/**
 * Canonicalises a raw source excerpt so that edits which do not change what the
 * code *does* do not change the fingerprint.
 *
 * Elides string and number literals and normalises whitespace, preserving
 * identifiers — renaming a variable IS a different finding, reindenting is not.
 *
 * Comments are deliberately NOT stripped. It looks like an obvious
 * normalisation, but several rules exist precisely to flag comments
 * ("TODO/FIXME marker", "Suppressed checker"), and for those the comment is the
 * entire evidence. Stripping it would reduce every TODO in a file to the same
 * empty snippet, collapsing them into one fingerprint and making it impossible
 * to suppress one TODO without suppressing all of them.
 */
export function normalizeSnippet(raw: string): string {
  return raw
    .replace(STRING_LITERAL_RE, STRING_SENTINEL)
    .replace(NUMBER_LITERAL_RE, NUMBER_SENTINEL)
    .replace(WHITESPACE_RUN_RE, " ")
    .replace(SPACE_BESIDE_PUNCTUATION_RE, "")
    .trim();
}

/**
 * Length-prefixed (netstring-style) join.
 *
 * A plain delimiter would make field boundaries ambiguous: with `|`, the pair
 * ("a", "b|c") and ("a|b", "c") produce the same string and therefore the same
 * fingerprint. Prefixing each field with its length removes that entirely, and
 * no separator character needs to be forbidden inside a snippet.
 */
function canonicalize(fields: readonly string[]): string {
  let out = "";
  for (const field of fields) {
    out += `${field.length}:${field}`;
  }
  return out;
}

/**
 * Stable identity for a finding.
 *
 * Excludes line, column, and file path by construction, which is the whole
 * point: a finding must survive reformatting, an unrelated edit above it, and
 * the file being moved or renamed. `scope` carries just enough location to keep
 * two identical snippets in different functions apart.
 *
 * 128 bits of SHA-256, hex. Truncated from the full digest because the full 64
 * characters buy nothing at this scale — with 128 bits a collision is not a
 * realistic failure mode for any repository — while a shorter value is
 * materially better to store, log, and put in a URL.
 */
export function fingerprint(input: FingerprintInput): string {
  const canonical = canonicalize([
    input.ruleId.trim(),
    input.scope.trim(),
    input.normalizedSnippet,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}
