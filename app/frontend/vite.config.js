import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The SPA and API are same-origin in production: Firebase Hosting rewrites
// `/api/**` to Cloud Run (see docs/architecture.md). In dev, Vite serves on a
// different port, so proxy `/api` to the local backend to preserve the
// same-origin relative-path contract api.js relies on — no CORS, no absolute
// URLs baked into the client.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
})
