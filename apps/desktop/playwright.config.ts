import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false, // Electron tests often share state or ports, better to run sequentially
  forbidOnly: !!process.env.CI,
  // Deliberately 0 under CI too. This suite boots the real Next standalone
  // server and indexes against it, so a retry does not paper over a network
  // blip — it hides a genuine race in the boot/health-check path and reports
  // green while proving nothing. If it flakes, that is the finding.
  retries: 0,
  workers: 1, // Ensure sequential execution
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
