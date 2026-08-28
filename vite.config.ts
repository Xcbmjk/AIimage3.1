import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'admin-entry-rewrite',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === '/admin' || request.url?.startsWith('/admin?')) request.url = '/admin/index.html'
        next()
      })
    },
  }],
  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        timeout: 360_000,
        proxyTimeout: 360_000,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin/index.html',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts'],
  },
})
