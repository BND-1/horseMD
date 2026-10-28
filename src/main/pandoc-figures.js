// Pandoc figures: rasterize the renderer's SVG figures to PNG (an offscreen
// window draws each as an <img>, so no script inside an SVG ever runs and a
// Mermaid <foreignObject> label still paints), write them where Pandoc will
// read them, and replace only the figures that rendered.
import { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { FIGURE_SCALE, figureName, pngWithDpi, spliceFigures, validFigures } from './pandoc-figures-core.js'

const FIGURE_TIMEOUT_MS = 10000

const pageFor = (figure) => {
  const width = figure.width * FIGURE_SCALE
  const height = figure.height * FIGURE_SCALE
  const src = figure.src.replace(/"/g, '%22')
  return '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">` +
    '<style>html,body{margin:0;background:#fff;overflow:hidden}img{display:block}</style></head><body>' +
    `<img width="${width}" height="${height}" src="${src}">` +
    '<script>const i=document.querySelector("img");const done=(s)=>{document.title=s};' +
    'if(i.complete&&i.naturalWidth)requestAnimationFrame(()=>requestAnimationFrame(()=>done("ok")));' +
    'else{i.onload=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done("ok")));i.onerror=()=>done("error")}</script>' +
    '</body></html>'
}

async function rasterize(win, figure) {
  const width = figure.width * FIGURE_SCALE
  const height = figure.height * FIGURE_SCALE
  win.setContentSize(width, height)
  const titled = new Promise((resolve) => {
    const onTitle = (_event, title) => {
      if (title !== 'ok' && title !== 'error') return
      win.webContents.off('page-title-updated', onTitle)
      resolve(title)
    }
    win.webContents.on('page-title-updated', onTitle)
    setTimeout(() => { win.webContents.off('page-title-updated', onTitle); resolve('timeout') }, FIGURE_TIMEOUT_MS)
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageFor(figure))}`)
  if (await titled !== 'ok') return null
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height })
  if (image.isEmpty()) return null
  return pngWithDpi(image.toPNG(), 96 * FIGURE_SCALE)
}

/**
 * markdown + renderer figures → { markdown, count } with every figure that
 * rendered written to `dir` (as `prefix` + name) and its source replaced by
 * an image of it. Never throws for a figure; a failure keeps its source.
 */
export async function applyPandocFigures({ markdown, figures, dir, prefix = '', html = false }) {
  const usable = validFigures(figures, String(markdown).length)
  if (!usable.length) return { markdown, count: 0 }
  await fs.mkdir(dir, { recursive: true })
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, images: true }
  })
  // The page only paints our own <img>: no navigation, no new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const rendered = []
  try {
    for (const figure of usable) {
      let png = null
      try {
        png = await rasterize(win, figure)
      } catch {
        png = null
      }
      if (!png) continue
      const name = figureName(rendered.length)
      await fs.writeFile(join(dir, name), png)
      rendered.push({ ...figure, path: prefix + name })
    }
  } finally {
    win.destroy()
  }
  return { markdown: spliceFigures(markdown, rendered, { html }), count: rendered.length }
}
