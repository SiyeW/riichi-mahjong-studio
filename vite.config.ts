import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      deny: ['.env', '.env.*', '*.{pem,key}', 'docs/**'],
    },
  },
  optimizeDeps: {
    entries: ['src/**/*.{vue,ts,js}'],
  },
})
