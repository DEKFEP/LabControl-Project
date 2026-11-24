import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    headless: true,
    viewport: { width: 1280, height: 800 }
  },
  webServer: {
    command: "node ../backend/server.js",
    url: "http://localhost:3100/login",
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: "3100",
      LC_JWT_EXPIRES: "3s",
      LC_API_LIMIT: "2000",
      LC_ESCRITURA_LIMIT: "2000",
      LC_LOGIN_LIMIT: "200",
      LC_DB_DIR: path.join(os.tmpdir(), `lc-e2e-db-${Date.now()}`),
      LC_SEED_DEMO: "1",
      LC_REGISTRO_DOMINIOS: "liceo.cl"
    }
  }
});