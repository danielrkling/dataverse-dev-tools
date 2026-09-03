import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8001',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8001',
    reuseExistingServer: true,
    timeout: 15000,
  },
});
