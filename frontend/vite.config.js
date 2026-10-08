import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In development, /api/* goes to the Identity API so the browser sees a
    // single origin (no CORS setup needed locally).
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4100', changeOrigin: true },
    },
  },
})
