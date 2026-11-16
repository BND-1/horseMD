import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let pdfJsPromise = null

// pdf.js 4 needs Promise.withResolvers (Chrome 119 / Safari 17.4). A phone
// whose system WebView is older (Huawei HarmonyOS 4, an un-updated Android
// WebView) loads pdf.js's legacy build (polyfilled, worker included) instead.
// Mobile build only: desktop Electron always has it.
const needsLegacyPdfJs = () => typeof Promise.withResolvers !== 'function'

export function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = __MOBILE_BUILD__ && needsLegacyPdfJs()
      ? Promise.all([
          import('pdfjs-dist/legacy/build/pdf.min.mjs'),
          import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
        ]).then(([pdfjs, worker]) => {
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default
          return pdfjs
        })
      : import('pdfjs-dist').then((pdfjs) => {
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
          return pdfjs
        })
  }
  return pdfJsPromise
}

export async function readPdfOutline(document, fallbackTitle) {
  const source = await document.getOutline().catch(() => null)
  const rows = []
  const collect = async (items, level = 0) => {
    for (const item of items || []) {
      let destination = item.dest
      if (typeof destination === 'string') {
        destination = await document.getDestination(destination).catch(() => null)
      }
      let page = null
      if (destination?.[0]) {
        const index = await document.getPageIndex(destination[0]).catch(() => null)
        if (index !== null) page = index + 1
      }
      rows.push({ title: item.title || fallbackTitle, level, page })
      await collect(item.items, level + 1)
    }
  }
  await collect(source)
  return rows
}
