import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Mobile (Capacitor) build: bundles ONLY the renderer into dist-mobile/ as a
// plain web app — no Electron main/preload. The desktop build (electron-vite)
// is untouched; this is a separate entry point. Capacitor wraps dist-mobile/
// in the native iOS/Android shell. The window.api contract is provided at
// runtime by src/renderer/src/platform (Capacitor shim) instead of preload.
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  // Capacitor serves the bundle from a custom scheme; assets must load relative.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __MOBILE_BUILD__: 'true'
  },
  build: {
    outDir: resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/renderer/index.html') }
    }
  },
  plugins: [react()]
})
