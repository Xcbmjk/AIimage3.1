import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: process.env.CI ? true : false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['iPhone 12 Pro Max'],
    // Kiosk is a portrait 1080x1920 device
    viewport: { width: 430, height: 932 },
    isMobile: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx server/index.ts',
      url: 'http://127.0.0.1:8787/api/health',
      timeout: 30_000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev:web',
      url: 'http://localhost:5173',
      timeout: 30_000,
      reuseExistingServer: true,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['iPhone 12 Pro Max'] },
    },
  ],
})
