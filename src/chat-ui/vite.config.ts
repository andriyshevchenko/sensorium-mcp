import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  root: resolve(__dirname),
  server: {
    port: 5174,
  },
  build: {
    outDir: resolve(__dirname, '../../dist/chat-ui'),
  },
})
