import { createToolbarScanner } from './editor-toolbar.js'
import { mountEditorContentBindings } from './editor-dom-content.js'
import { mountEditorInteractionBindings } from './editor-dom-interactions.js'
import { mountEditorLayoutBindings } from './editor-dom-layout.js'

export function mountEditorDomBindings({
  view,
  viewRef,
  host,
  docPath,
  crepe,
  liveEditors,
  self,
  cleanups,
  markUserEdit,
  insertUploadedImage,
  prepareRawMarkdownPaste,
  reportActiveBlock,
  setBlock,
  setCtxMenu,
  setZoom,
  getT,
  getKeybindings,
  isDestroyed
}) {
  if (!view) return

  const { updateHighlightActive } = mountEditorInteractionBindings({
    view,
    viewRef,
    cleanups,
    markUserEdit,
    reportActiveBlock,
    setBlock,
    setCtxMenu,
    getKeybindings
  })

  mountEditorLayoutBindings({
    view,
    host,
    cleanups,
    markUserEdit,
    reportActiveBlock
  })

  mountEditorContentBindings({
    view,
    docPath,
    crepe,
    cleanups,
    insertUploadedImage,
    prepareRawMarkdownPaste,
    setZoom,
    getT,
    isDestroyed
  })

  const platform = window.api?.platform
  const isMobile = platform === 'ios' || platform === 'android'
  if (!isMobile) {
    const { scanToolbars, cleanup: cleanupToolbarScan } = createToolbarScanner({
      liveEditors,
      self,
      t: getT,
      getKeybindings,
      updateHighlightActive
    })
    scanToolbars()
    cleanups.push(cleanupToolbarScan)
  }
}
