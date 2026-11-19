// Content with local images copied from one document and pasted into a
// document in another folder (lib/pasted-image-refs.js, main/pasted-images.js).
// The copy marks its document (SOURCE_DOC_MIME); the paste, when the source
// is another folder and the content holds relative images, waits for main to
// make each image valid for the target, then pastes the rewritten clipboard
// through the normal paste path (a re-dispatched paste event).
import { SOURCE_DOC_MIME, collectRelativeImageRefs, readSourceDocPath, rewriteImageRefs, sameDocumentFolder } from '../lib/pasted-image-refs.js'
import { dirOf, isRelativePath, resolveToFileUrl } from './editor-images.js'

const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\/)/

// Copy / cut listener (bubble phase, after ProseMirror's own): only a copy
// whose data was written by the page (default prevented) keeps extra types.
// Only copies that hold an image get the type (复制纯文本 writes text/plain
// alone and is skipped by its caller).
export function markClipboardSource(event, docPath) {
  const data = event.clipboardData
  if (!docPath || !ABSOLUTE_PATH_RE.test(docPath) || !event.defaultPrevented || !data) return
  const hasImage = ['text/markdown', 'text/plain', 'text/html'].some((t) => /!\[|<img/i.test(data.getData(t) || ''))
  if (!hasImage) return
  try {
    event.clipboardData.setData(SOURCE_DOC_MIME, JSON.stringify({ docPath }))
  } catch {}
}

const htmlImageUrls = (html) => {
  if (!html || !/<img/i.test(html)) return []
  const template = document.createElement('template')
  template.innerHTML = html
  return [...template.content.querySelectorAll('img[src]')].map((img) => img.getAttribute('src')).filter(isRelativePath)
}

// null when nothing has to change (same folder, no relative image, no API).
export function planPastedImages(clipboardData, targetDocPath) {
  if (!window.api?.importPastedImages || !clipboardData) return null
  const sourceDocPath = readSourceDocPath(clipboardData)
  if (!sourceDocPath || !ABSOLUTE_PATH_RE.test(sourceDocPath)) return null
  if (targetDocPath && sameDocumentFolder(sourceDocPath, targetDocPath)) return null
  const texts = {
    markdown: clipboardData.getData('text/markdown') || '',
    plain: clipboardData.getData('text/plain') || '',
    html: clipboardData.getData('text/html') || ''
  }
  const refs = { markdown: collectRelativeImageRefs(texts.markdown), plain: collectRelativeImageRefs(texts.plain) }
  const urls = new Set([...refs.markdown, ...refs.plain].map((r) => r.url))
  for (const url of htmlImageUrls(texts.html)) urls.add(url)
  if (!urls.size) return null
  const types = [...(clipboardData.types || [])].filter((t) => t !== 'Files' && t !== SOURCE_DOC_MIME)
  const other = Object.fromEntries(types.map((t) => [t, clipboardData.getData(t)]))
  return { sourceDocPath, targetDocPath: targetDocPath || null, texts, refs, urls: [...urls], other }
}

// The rendered copy shows each image by its file:// URL in the source folder
// (editor-dom-content.js resolves relative srcs for display).
function rewriteHtml(html, mapping, sourceDir) {
  if (!html || !/<img/i.test(html)) return html
  const byFileUrl = {}
  for (const [url, next] of Object.entries(mapping)) byFileUrl[resolveToFileUrl(sourceDir, url)] = next
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  for (const img of template.content.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src')
    const next = mapping[src] || byFileUrl[src]
    if (next) {
      img.setAttribute('src', next)
      changed = true
    }
  }
  return changed ? template.innerHTML : html
}

// The clipboard to paste instead: the same types, image paths rewritten.
export async function resolvePastedImages(plan) {
  let mapping = {}
  try {
    const res = await window.api.importPastedImages(plan.sourceDocPath, plan.targetDocPath, plan.urls)
    mapping = res?.results || {}
  } catch {}
  const data = new DataTransfer()
  const rewritten = {
    'text/markdown': rewriteImageRefs(plan.texts.markdown, plan.refs.markdown, mapping),
    'text/plain': rewriteImageRefs(plan.texts.plain, plan.refs.plain, mapping),
    'text/html': rewriteHtml(plan.texts.html, mapping, dirOf(plan.sourceDocPath))
  }
  for (const [type, value] of Object.entries(plan.other)) {
    data.setData(type, type in rewritten ? rewritten[type] : value)
  }
  return { data, mapping, text: rewritten['text/plain'] }
}

// Source mode (EditorArea textarea). A copy / cut holding image syntax names
// its document; other copies stay native.
export function copySourceSelection(event, docPath, cut = false) {
  const ta = event.currentTarget
  if (!docPath || !ABSOLUTE_PATH_RE.test(docPath) || !event.clipboardData || !ta) return
  const text = ta.value.slice(ta.selectionStart, ta.selectionEnd)
  if (!text || !/!\[|<img/i.test(text)) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
  try { event.clipboardData.setData(SOURCE_DOC_MIME, JSON.stringify({ docPath })) } catch {}
  if (cut) document.execCommand('delete')
}

// A paste into a source textarea: the rewritten plain text, inserted where the
// paste was aimed (execCommand keeps the textarea's undo and fires input).
export function pasteSourceWithImages(event, docPath) {
  const ta = event.currentTarget
  const plan = planPastedImages(event.clipboardData, docPath)
  if (!plan || !plan.refs.plain.length || !ta) return
  event.preventDefault()
  const value = ta.value
  const { selectionStart, selectionEnd } = ta
  resolvePastedImages(plan).then(({ text }) => {
    if (!ta.isConnected || ta.readOnly) return
    ta.focus()
    if (ta.value === value) ta.setSelectionRange(selectionStart, selectionEnd)
    document.execCommand('insertText', false, text)
  })
}
