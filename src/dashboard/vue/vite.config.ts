import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  build: {
    outDir: resolve(__dirname, '../../../dist/dashboard'),
    emptyOutDir: false,
  }
})
