"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Search } from "lucide-react";
import Link from "next/link";
import type { AskIntent, AskPlan, AskResult } from "@codegraph/core-graph";
import { intelAsk } from "@/lib/api";
import { directionApplies, intentsFor, phraseFor, transitiveApplies, type PlanDraft } from "@/lib/askPhrase";
import { editorHref } from "@/lib/findings";
import { plural } from "@/lib/plural";
import { SectionHead, useRepo } from "../repo-context";

/**
 * Ask the graph a question, in English, with no model involved.
 *
 * WHY THE PLAN IS ON SCREEN AND NOT BEHIND A TOGGLE
 *
 * Every other answer in this product shows its working: the Health Score lists the dimensions
 * that moved it, a finding carries the line that triggered it. A natural-language box is the
 * one surface where a reader has no way to tell an analysis from a guess, so the compiled
 * plan - the intent, the entity it bound, the direction it walked, the operations it ran - is
 * rendered next to the answer rather than hidden. It is the same promise the rest of the
 * report makes, kept in the place it is easiest to break.
 *
 * A question the compiler cannot classify is answered as a refusal listing the forms that do
 * work. That is deliberate and it is the feature: the alternative is a confident wrong answer
 * about who calls what, which a reader cannot detect.
 */

/** Enough to teach the grammar without turning the page into documentation. */
const SUGGESTIONS = [
  "what breaks if I change ",
  "what depends on ",
  "which endpoints are unauthenticated",
  "what is dead code",
  "what are the circular dependencies",
  "what is untested",
];

export default function AskPage() {
  const repo = useRepo();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  /* The question lives in the URL so an answer can be shared and re-derived, exactly like
     `?symbol=` on the impact page. Same question, same repository, same answer. */
  const asked = params.get("q") ?? "";

  const [draft, setDraft] = useState(asked);
  const [result, setResult] = useState<AskResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(asked), [asked]);

  useEffect(() => {
    if (!asked.trim()) {
      setResult(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    intelAsk(repo.id, asked)
      .then((r) => { if (active) setResult(r); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Query failed"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repo.id, asked]);

  const submit = useCallback(
    (q: string) => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set("q", q.trim());
      else next.delete("q");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return (
    <div className="flex flex-col gap-lg">
      <SectionHead
        eyebrow="Intelligence"
        title="Ask"
        blurb="A question in English, compiled into graph operations and answered from the index. No model, no network: the same question always compiles to the same plan."
      />

      <form
        onSubmit={(e) => { e.preventDefault(); submit(draft); }}
        className="flex items-center gap-sm rounded-lg border border-[var(--line)] bg-[var(--surface-1)] px-md py-sm focus-within:border-[var(--accent-fill)]"
      >
        <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={300}
          placeholder="what breaks if I change indexRepo"
          aria-label="Ask a question about this repository"
          className="w-full bg-transparent text-body text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" /> : null}
        <button type="submit" className="shrink-0 rounded-md bg-[var(--accent-fill)] px-md py-2xs text-meta font-medium text-[var(--accent-on-fill)] transition-colors duration-200 hover:bg-[var(--signal-400)]">
          Ask
        </button>
      </form>

      {!asked.trim() && (
        <div className="flex flex-wrap gap-xs">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => (s.endsWith(" ") ? setDraft(s) : submit(s))}
              className="rounded-full border border-[var(--line)] px-sm py-hair text-meta text-[var(--text-secondary)] hover:border-[var(--line-strong)] hover:text-[var(--text-primary)]"
            >
              {s.trim()}
              {s.endsWith(" ") ? " …" : ""}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-[var(--coral-500)]/30 bg-[var(--coral-500)]/10 p-md text-meta text-[var(--coral-text)]">{error}</p>
      )}

      {result && !result.ok && (
        <div className="flex flex-col gap-md rounded-xl border border-[var(--line)] bg-[var(--surface-1)] p-lg">
          <p className="text-body text-[var(--text-primary)]">{result.message}</p>
          {result.didYouMean.length > 0 && (
            <div className="flex flex-col gap-xs">
              <span className="text-meta uppercase tracking-wider text-[var(--text-muted)]">Did you mean</span>
              <div className="flex flex-wrap gap-xs">
                {result.didYouMean.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(asked.replace(/\S+\s*$/, s))}
                    className="rounded-full border border-[var(--line)] px-sm py-hair font-mono text-meta text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-xs border-t border-[var(--line-soft)] pt-md">
            <span className="text-meta uppercase tracking-wider text-[var(--text-muted)]">Forms this graph can answer</span>
            <ul className="flex flex-col gap-hair">
              {result.examples.map((x) => (
                <li key={x}>
                  <button type="button" onClick={() => submit(x)} className="text-left font-mono text-meta text-[var(--text-secondary)] hover:text-[var(--accent-text)]">
                    {x}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {result?.ok && (
        <div className="flex flex-col gap-md">
          <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-1)] p-lg">
            <p className="text-body text-[var(--text-primary)]">{result.headline}</p>
            {/* The receipt. See the module comment: this is why the surface is trustworthy. */}
            <div className="mt-md flex flex-wrap items-center gap-xs border-t border-[var(--line-soft)] pt-md text-micro text-[var(--text-muted)]">
              <span className="rounded bg-[var(--surface-3)] px-xs py-hair font-mono uppercase tracking-wider">{result.plan.intent}</span>
              {result.plan.entity && (
                <span className="rounded bg-[var(--surface-3)] px-xs py-hair font-mono">
                  {result.plan.entity.kind}: {result.plan.entity.label}
                </span>
              )}
              {result.plan.direction !== "none" && (
                <span className="rounded bg-[var(--surface-3)] px-xs py-hair font-mono uppercase">{result.plan.direction}</span>
              )}
              {result.plan.transitive && <span className="rounded bg-[var(--surface-3)] px-xs py-hair font-mono uppercase">transitive · depth {result.plan.depth}</span>}
              <span className="font-mono">{result.plan.operations.join(" · ")}</span>
            </div>

            {/*
              * The receipt above says what ran. These say what to run INSTEAD.
              *
              * Measured classifier recall is high but not perfect, and the failure a reader
              * cannot recover from is a plan that is nearly right - correct entity, wrong
              * direction. Rephrasing blindly is a guessing game; changing the chip is not.
              * Every control rewrites the QUESTION through `phraseFor`, so the compiler still
              * does the classifying and there is exactly one code path. A synthesised phrase
              * that would not round-trip is not offered at all: `phraseFor` returns null and
              * the control disappears rather than producing a question the compiler misreads.
              */}
            <PlanControls plan={result.plan} onChange={submit} />
          </div>

          {result.chains?.length ? (
            <div className="flex flex-col gap-sm rounded-xl border border-[var(--line)] bg-[var(--surface-1)] p-lg">
              <span className="text-meta uppercase tracking-wider text-[var(--text-muted)]">Resolved flow</span>
              {result.chains.map((c, i) => (
                <div key={i} className="flex flex-col gap-hair">
                  <div className="flex flex-wrap items-center gap-xs font-mono text-meta text-[var(--text-primary)]">
                    {c.steps.map((s, j) => (
                      <span key={j} className="flex items-center gap-xs">
                        {j > 0 && <ArrowRight className="h-3 w-3 text-[var(--text-muted)]" />}
                        {s}
                      </span>
                    ))}
                  </div>
                  {c.sink && <span className="text-micro text-[var(--text-muted)]">reaches {c.sink}</span>}
                </div>
              ))}
            </div>
          ) : null}

          {result.rows.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-[var(--line)]">
              {result.rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-md border-b border-[var(--line-soft)] bg-[var(--surface-1)] px-md py-sm last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate text-meta text-[var(--text-primary)]">{r.label}</div>
                    <div className="truncate text-micro text-[var(--text-muted)]">{r.detail}</div>
                  </div>
                  {/* Every row is a place in the code, so every row opens there. */}
                  <Link
                    href={editorHref(repo.id, r.file, r.line)}
                    className="shrink-0 font-mono text-micro text-[var(--text-secondary)] hover:text-[var(--accent-text)]"
                  >
                    {r.file}:{r.line}
                  </Link>
                </div>
              ))}
            </div>
          )}

          {result.truncated && (
            <p className="text-meta text-[var(--text-muted)]">
              A cap was reached: this answer is a prefix of the truth, not the whole of it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One control chip: a label and whatever sets it. */
function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-xs rounded border border-[var(--line)] bg-[var(--surface-2)] px-xs py-hair">
      <span className="text-micro uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
      {children}
    </label>
  );
}

const SELECT = "bg-transparent text-micro font-mono text-[var(--text-primary)] outline-none";

/**
 * The plan, as controls.
 *
 * Each change is expressed by rewriting the QUESTION, never by posting a plan: `phraseFor`
 * produces a canonical sentence the compiler is guaranteed to classify back to this plan, and
 * `ask-phrase.test.ts` asserts that round-trip for every combination offered here. So the
 * controls cannot drift away from the grammar - if a phrasing stopped compiling, that test
 * fails rather than this panel silently generating questions the compiler misreads.
 */
function PlanControls({ plan, onChange }: { plan: AskPlan; onChange: (q: string) => void }) {
  const draft: PlanDraft = { intent: plan.intent, entity: plan.entity, direction: plan.direction, transitive: plan.transitive };
  const emit = (next: Partial<PlanDraft>) => {
    const phrase = phraseFor({ ...draft, ...next });
    if (phrase) onChange(phrase);
  };

  const intents = intentsFor(plan.entity?.kind ?? null);
  // Nothing to switch between, and no modifier applies: a panel with one frozen control is
  // furniture. Drawn only when it can actually change the answer.
  const canSwitchIntent = intents.length > 1;
  if (!canSwitchIntent && !directionApplies(draft) && !transitiveApplies(draft)) return null;

  return (
    <div className="mt-sm flex flex-wrap items-center gap-xs">
      <span className="text-micro uppercase tracking-wider text-[var(--text-muted)]">Not what you meant?</span>
      {canSwitchIntent && (
        <Control label="ask">
          <select className={SELECT} value={plan.intent} onChange={(e) => emit({ intent: e.target.value as AskPlan["intent"] })}>
            {intents.map((i) => (
              <option key={i} value={i}>{i.replace(/_/g, " ")}</option>
            ))}
          </select>
        </Control>
      )}
      {directionApplies(draft) && (
        <Control label="direction">
          <select className={SELECT} value={plan.direction} onChange={(e) => emit({ direction: e.target.value as AskPlan["direction"] })}>
            <option value="inbound">inbound · what reaches it</option>
            <option value="outbound">outbound · what it reaches</option>
          </select>
        </Control>
      )}
      {transitiveApplies(draft) && (
        <Control label="depth">
          <select className={SELECT} value={plan.transitive ? "transitive" : "direct"} onChange={(e) => emit({ transitive: e.target.value === "transitive" })}>
            <option value="direct">direct only</option>
            <option value="transitive">transitive</option>
          </select>
        </Control>
      )}
    </div>
  );
}
