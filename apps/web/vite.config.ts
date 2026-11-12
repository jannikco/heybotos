import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// Dev server on a port of its own (not Vite's usual 5173, which other projects tend to hold); the API is proxied to
// the daemon. Start the daemon with HEYBOTOS_DEV_ORIGIN=http://127.0.0.1:5175 so it accepts this origin.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4747', changeOrigin: true },
      '/auth': { target: 'http://127.0.0.1:4747', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023' },
})
