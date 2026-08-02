import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The supervision tests spawn real child processes, two of which deliberately
    // ignore SIGTERM to prove the SIGKILL escalation bounds cancellation latency.
    // The default 5s timeout is shorter than that escalation.
    testTimeout: 30_000,
  },
});
