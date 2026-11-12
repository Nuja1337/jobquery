import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Demo mode: serves only the interface, with sample data, in a normal browser. It starts no
// Electron window and never touches your real JobQuery data. Run it with `npm run demo`.
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  plugins: [react(), tailwindcss()],
  server: { port: 5173 }
})
