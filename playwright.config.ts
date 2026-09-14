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
      command: 'python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8787',
      url: 'http://127.0.0.1:8787/api/health',
      timeout: 30_000,
      env: {
        APP_ENV: 'test',
        MYSQL_ENABLED: 'false',
        DATABASE_URL: 'sqlite+aiosqlite:///./data/e2e.sqlite3',
        // APP_ENV=test with no model_configs row is what selects the mock
        // provider now; the vendor itself is never chosen from the environment.
        STATIC_DIRECTORY: 'dist',
      },
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
