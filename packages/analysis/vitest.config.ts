import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // indexRepo walks a real temp repository and initialises parsers.
    testTimeout: 30_000,
  },
});
