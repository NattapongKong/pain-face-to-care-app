import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vitejs.dev/config/
// HTTPS (self-signed) is needed only for camera access from OTHER devices on the
// LAN (npm run dev:lan); localhost is already a secure context, and plain HTTP
// keeps local browsing/automation free of the certificate interstitial.
export default defineConfig({
  base: './',
  plugins: [vue(), ...(process.env.USE_SSL ? [basicSsl()] : [])],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: './tests/setup.js',
    globals: true,
  },
})
