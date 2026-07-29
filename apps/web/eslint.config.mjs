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
    // Note that `npm run lint` is not currently green for unrelated,
    // pre-existing reasons (REVIEW_2026-07-29 P1-4), which is exactly why the
    // real gate is not an ESLint rule.
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
      "no-console": [
        "error",
        {
          allow: [],
        },
      ],
    },
  },
];
