import { defineConfig, devices } from "@playwright/test";

const PORT = 5399;
const TOKEN = "test-token";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // single server port — no parallel workers
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // Strip any stale localStorage between tests (storageState per context)
    storageState: { cookies: [], origins: [] },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Build then serve the production SPA bundle
    command: "bun run build:web && bun run dev",
    url: `http://127.0.0.1:${PORT}/?t=${TOKEN}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      DIFFRACTION_TOKEN: TOKEN,
    },
  },
});
