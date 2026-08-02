# Lint debt — `react-hooks` v7

| | |
|---|---|
| **Recorded** | 2026-07-30 |
| **Why this file exists** | `npm run lint` was **dead**, not clean. Turning it on surfaced 17 pre-existing errors. This records what they are and which are real, so the gate can go into CI now without either hiding them or blind-refactoring the view layer mid-phase. |

## How this went unnoticed

Two independent failures, and it took both:

1. `apps/web/eslint.config.mjs` set `"no-console": ["error", { allow: [] }]`. Under ESLint 9,
   `allow` must have at least one item, so the config was **invalid** and `eslint` exited 2
   before linting a single file. A gate that crashes blocks nothing and passes nothing.
2. **CI never ran `npm run lint`.** `.github/workflows/ci.yml` ran typecheck, depcruise,
   `check_boundaries.py`, test, and build — so nothing ever invoked the crashing script.

Either alone would have been caught. Together they made a Definition-of-Done item
(`npm run lint` clean, PROMPT_P1) unobservable for the life of the branch.

Both are fixed: the rule is now bare `"error"`, and lint runs in CI.

## The 17 errors

`eslint-plugin-react-hooks@7.1.1` is a React-Compiler-era major. Both rules below **postdate**
the code they flag, so this is accumulated drift, not a regression someone introduced.

### `react-hooks/refs` — 7 sites · **genuinely wrong**

`CirclePackView.tsx` L148, 153, 209, 217, 241, 284 · `NodeGraph.tsx` L210

```ts
const [vx, vy, vd] = viewRef.current;   // CirclePackView.tsx:147
const atRoot = focusRef.current === root;
```

The rendered output is **derived from a ref**. React has no way to know the output is stale, so
under concurrent rendering or StrictMode double-invocation the view can render torn or
one-frame-behind state. This is a real correctness bug, not rule churn.

It is also an architectural fix, not a local one: the zoom/focus transform is held in a ref
*specifically* to drive an animation loop without re-rendering per frame, and moving it into
state means re-doing that loop (`useSyncExternalStore`, or committing the transform to state at
animation boundaries). That is a change to the pan/zoom behaviour of the views IDENTITY.md §1
calls "the product", and it needs interaction testing — not a mid-phase edit.

**Owed work:** move the transform out of render. Not scheduled here; see below for why the gate
does not wait on it.

### `react-hooks/set-state-in-effect` — 10 sites · **mostly rule premise not holding**

`page.tsx` L50 · `CirclePackView.tsx` L49 · `CodeIntelPanel.tsx` L27, L44 · `FolderBrowser.tsx`
L25 · `NodeGraph.tsx` L136, L145 · `FileExplorer.tsx` L65 · `GitPanel.tsx` L69 ·
`TrashPanel.tsx` L37

Nearly all are the async-load-on-mount shape:

```ts
useEffect(() => { load(); }, [repoId]);   // load() awaits, then setState
```

The rule's stated harm is *synchronous* cascading renders. When `load()` sets state after an
`await`, the render pass has already committed, so that specific harm does not occur. The rule
cannot distinguish the two, and flags both.

They are not therefore *good* — each is a data fetch that would be better expressed as a
subscription or a suspense-ready resource — but they are style debt at present, not defects.

## Why the gate ships before the debt is paid

Each site carries an `eslint-disable-next-line` naming the rule **and** pointing here. That is
deliberately per-site rather than a `files:`-scoped override in the config:

- A file-scoped override would let **new** violations into the same files silently. A per-site
  disable is a true ratchet — the 17 known sites pass, and the 18th fails CI.
- Every disable is greppable, so the debt has an exact size that can be watched shrink:

```
$ grep -rn "LINT_DEBT" apps/web/src | wc -l
```

Deleting a disable is the unit of progress. If that count rises, the ratchet leaked.

**The alternative was worse.** Leaving lint out of CI to avoid the noise is what produced this
situation, and refactoring the animation loop of the primary views inside a phase about
verification is how unrelated breakage gets shipped.
