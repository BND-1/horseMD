import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let pdfJsPromise = null

export function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist').then((pdfjs) => {
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
