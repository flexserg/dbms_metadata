import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: "node src/server.js",
    url: "http://127.0.0.1:3000/health/ready",
    reuseExistingServer: false,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ||
        "postgresql://metadata:integration-password@127.0.0.1:55432/metadata",
      APP_KEY: "ab".repeat(32),
      APP_PASSWORD: "integration-password",
      COOKIE_SECURE: "false",
    },
  },
});
