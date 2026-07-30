import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Gate 2 and 3 spawn real toolchains against real temp projects.
    testTimeout: 60_000,
  },
});
