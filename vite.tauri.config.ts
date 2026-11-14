import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { outDir: resolve('out/tauri'), emptyOutDir: true, rollupOptions: { input: [resolve('src/renderer/prototype.html'), resolve('src/renderer/tauri.html'), resolve('src/renderer/widget.html'), resolve('src/renderer/recovery.html'), resolve('src/renderer/capture.html'), resolve('src/renderer/pin.html'), resolve('src/renderer/quick.html'), resolve('src/renderer/runtime-import.html')] } }
})
