# `@codegraph/analysis` — transitional

**This package is a staging area, not a destination.** It exists so that P2 can put
a worker process behind the analysis pipeline without first performing P3's
five-way split of `lib/indexer.ts`.

## Why it exists

`apps/worker` cannot import `apps/web` — `no-cross-app-imports` forbids it, and
that rule is the mechanism that makes the worker's process boundary structural
rather than a convention a future route can quietly bypass. But the analyse
handler needs `indexRepo`, which lived in `apps/web/src/lib`. Something had to
move, and the alternative — cutting a 901-line file four ways inside a phase whose
constraint is *no behaviour change* — would have meant drawing `detect-engine`'s
boundary before the detection work that reveals where it belongs.

See [`LLD §13.2`](../../docs/design/LLD.md) and the P2 note under
[`HLD §17`](../../docs/design/HLD.md).

## What P3 does to it

Per the `lib/indexer.ts` row of LLD §13's migration map, this package is split:

| Concern currently here | Goes to |
|---|---|
| file enumeration / `walk` | `pipeline/enumerate` |
| import-graph extraction | `lang-typescript`, `lang-python` |
| the `RULES` array and `eslintSecurity` | `detect-engine`, `detect-rules` |
| `scoreIssues`, `DIMENSION_META` | `score-engine` |
| `buildVizGraph`, tree, module graph | `viz` |

It is deliberately **not** named `score-engine`. `scoreIssues` is one of two
exports; the same file also walks the tree, extracts imports, runs the rule array,
and builds three graphs. A package named `score-engine` containing all of that
would be a name that lies, and P3 has to dismantle it either way — so the misnomer
would be paid for twice and corrupt the taxonomy in between.

## Two things to know before editing

**The v1 models here are not `core-domain`'s.** `Dimension` here has five members;
`core-domain`'s has six (it includes `"performance"`). That is not a merge waiting
to happen — `scoreIssues` computes the overall score as `Σ score × weight` with the
five weights summing to exactly 1.0, so adopting the six-member type forces a sixth
weight taken from the other five and moves every repository's Health Score.
Reconciling them is P3 work with a real design question behind it: does
`performance` earn score weight, and taken from where?

**`eslint`, `@typescript-eslint/parser`, and `eslint-plugin-security` are real
runtime dependencies here**, declared as such. They were not in `apps/web`:
`eslint` sat in `devDependencies` and `@typescript-eslint/parser` was not declared
at all, working only through npm hoisting. That was survivable there because
Turbopack inlines all three into the server chunk — verified, the deployed bundle
carries `eslint-plugin-security@4.0.1`'s own module — but `apps/worker` is plain
Node with no bundler, so it needs them declared to resolve them at all.
