// esbuild bundler — bundles webview.js + CSS into media/editor.js + media/editor.css
import esbuild from 'esbuild'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ext = resolve(__dirname, '..')
const media = resolve(ext, 'media')

mkdirSync(media, { recursive: true })

// Bundle webview entry + CSS → IIFE + extracted CSS (KaTeX fonts inlined as dataurl)
await esbuild.build({
  entryPoints: [resolve(ext, 'src/webview.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  outfile: resolve(media, 'editor.js'),
  minify: true,
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  legalComments: 'none',
  logLevel: 'info',
})

console.log('Build complete → media/editor.js + media/editor.css')
