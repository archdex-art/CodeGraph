import nextConfig from "eslint-config-next";

// `eslint-config-next` (16.x) ships a ready-to-use ESLint 9 flat config
// array — no FlatCompat/legacy-shim layer needed. This file was missing
// entirely, which meant `npm run lint` (and any CI lint gate) failed
// immediately with "ESLint couldn't find an eslint.config.(js|mjs|cjs)
// file" rather than actually linting anything.
export default [
  ...nextConfig,
  {
    ignores: ["data/**", "tsconfig.tsbuildinfo"],
  },
];
