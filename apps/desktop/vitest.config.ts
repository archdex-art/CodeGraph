import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run TypeScript unit tests colocated with source. The Playwright
    // Electron suite lives in e2e/ (own runner), and compiled CommonJS test
    // files in dist/ must never be picked up by Vitest.
    include: ["src/**/*.test.ts", "shared/**/*.test.ts"],
    exclude: ["dist/**", "build/**", "node_modules/**", "e2e/**"],
    environment: "node",
  },
});
