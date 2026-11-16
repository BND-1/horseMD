// Native PDF rendering for phone export (Capacitor). Native side:
//   ios/App/App/HorsePdfPlugin.swift (WKWebView + UIPrintPageRenderer)
//   android/app/src/main/java/com/horsemd/app/HorsePdfPlugin.java
//   (+ android/print/HorsePdfWriter.java: WebView PrintDocumentAdapter)
// Registered in MainViewController.swift / MainActivity.java like HorseHttp.
//
// HorsePdf.render({ html, pageWidthPt, pageHeightPt,
//                   margins: { top, right, bottom, left } (pt),
//                   resourceScript, timeoutMs })
//   → { data: <base64 PDF>, pageCount, resources: <resourceScript's result | null> }
//   Off-screen, never shown, destroyed after each render. One render at a
//   time. Rejects with error.code TIMEOUT | RENDER | BUSY.
import { registerPlugin } from '@capacitor/core'
import { base64ToBytes } from './native-sync.js'

export const HorsePdf = registerPlugin('HorsePdf')

/** @returns {Promise<{ bytes: Uint8Array, pageCount: number, resources: object|null }>} */
export async function renderPdf({ html, pageWidthPt, pageHeightPt, margins, resourceScript, timeoutMs = 90000, viewportWidth }) {
  let result
  try {
    result = await HorsePdf.render({ html, pageWidthPt, pageHeightPt, margins, resourceScript, timeoutMs, viewportWidth })
  } catch (error) {
    const e = new Error(error?.message || 'PDF rendering failed')
    e.code = error?.code || 'RENDER'
    throw e
  }
  let resources = result?.resources ?? null
  if (typeof resources === 'string') {
    try { resources = JSON.parse(resources) } catch { resources = null }
  }
  return {
    bytes: base64ToBytes(result?.data || ''),
    pageCount: Number(result?.pageCount) || 0,
    resources
  }
}
