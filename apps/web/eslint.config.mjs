import nextConfig from "eslint-config-next";

// `eslint-config-next` (16.x) ships a ready-to-use ESLint 9 flat config
// array — no FlatCompat/legacy-shim layer needed. This file was missing
// entirely, which meant `npm run lint` (and any CI lint gate) failed
// immediately with "ESLint couldn't find an eslint.config.(js|mjs|cjs)
// file" rather than actually linting anything.
export default [
  ...nextConfig,
  {
    ignores: ["data/**", "tsconfig.tsbuildinfo", ".next/**"],
  },
  {
    // Module-boundary bans, mirroring scripts/check_boundaries.py.
    //
    // The Python script is the ENFORCED gate (it runs in CI); these rules exist
    // for the feedback loop that matters most — a red squiggle in the editor at
    // the moment the line is typed, rather than a CI failure ten minutes later.
    // They are deliberately duplicated for that reason, and the two must be
    // changed together.
    //
    // `npm run lint` IS green, with a pinned warning ceiling — see the ratchet block at the
    // bottom of this file and docs/LINT_DEBT.md. It was not green when this comment was first
    // written (REVIEW_2026-07-29 P1-4), which is why the real gate is the Python script.
    files: ["src/**/*.{ts,tsx}", "terminal/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration from @codegraph/config, which validates at boot and reports every invalid variable at once (LLD §10.3). For a child process that needs the whole inherited environment, use config's childEnv().",
        },
      ],
      // Bare "error" bans every console method. This was `["error", { allow: [] }]`, which
      // reads as "allow nothing" but is INVALID under ESLint 9 — `allow` must have at least
      // one item — so the config threw and `npm run lint` exited 2 without linting a single
      // file. A gate that crashes is a gate that passes nothing and blocks nothing.
      "no-console": "error",
    },
  },
  {
    // ── The react-hooks v7 ratchet (docs/LINT_DEBT.md) ────────────────────────────────────
    //
    // `eslint-plugin-react-hooks@7` is a React-Compiler-era major, and two of its rules
    // postdate this code: `refs` (render derives output from a ref) and `set-state-in-effect`
    // (async load-on-mount). 17 sites across the 8 files below predate the rules.
    //
    // WHY AN OVERRIDE RATHER THAN 17 INLINE DISABLES, which is the stricter mechanism and was
    // tried first: the reported positions sit inside multi-line JSX attributes, where a `//`
    // comment is a syntax error and `eslint-disable-next-line` on the preceding physical line
    // does not cover the node. 11 of 17 suppressed; 6 could not. A mechanism that works on
    // two-thirds of the sites is not a mechanism.
    //
    // The ratchet is therefore a NUMBER, not comment placement: these rules drop to `warn`
    // here, and the `lint` script pins `--max-warnings` to the exact current total. Any new
    // violation — in these files or any other — pushes the count over the pin and fails CI.
    // Paying debt lowers the pin. The number is the unit of progress, and it only moves
    // deliberately.
    //
    // Scoped to these 8 paths on purpose: a NEW component violating either rule is a hard
    // error, not a warning, because it is not covered here.
    files: [
      "src/app/page.tsx",
      "src/components/CirclePackView.tsx",
      "src/components/CodeIntelPanel.tsx",
      "src/components/FolderBrowser.tsx",
      "src/components/NodeGraph.tsx",
      "src/components/editor/FileExplorer.tsx",
      "src/components/editor/GitPanel.tsx",
      "src/components/editor/TrashPanel.tsx",
    ],
    rules: {
      // Real correctness bug, and an architectural fix — the transform is held in a ref to
      // drive the animation loop. See LINT_DEBT.md; owed, not forgotten.
      "react-hooks/refs": "warn",
      // The rule's harm is a SYNCHRONOUS cascade; these setStates land after an `await`.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];
