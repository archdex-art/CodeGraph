import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false, // Electron tests often share state or ports, better to run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Ensure sequential execution
  reporter: "list",
  use: {
    trace: "on-first-retry",
  },
});
