import { createToolbarScanner } from './editor-toolbar.js'
import { mountEditorContentBindings } from './editor-dom-content.js'
import { mountCodeBlockFold } from './editor-codeblock-fold.js'
import { mountSvgCodeBlockToggle } from './editor-svg-codeblock.js'
import { mountCodeBlockLanguageInput } from './editor-codeblock-language.js'
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
  onRichEditPending,
  insertUploadedImage,
  prepareRawMarkdownPaste,
  reportActiveBlock,
  setBlock,
  canConvertBlockToList,
  getListConversionContext,
  setCtxMenu,
  setZoom,
  getT,
  getKeybindings,
  getSelectionToolbarEnabled,
  onMarkdownInputIntent,
  isReadOnly,
  isDestroyed
}) {
  if (!view) return

  const { updateHighlightActive } = mountEditorInteractionBindings({
    view,
    viewRef,
    cleanups,
    markUserEdit,
    onRichEditPending,
    reportActiveBlock,
    setBlock,
    canConvertBlockToList,
    getListConversionContext,
    setCtxMenu,
    getKeybindings,
    getSelectionToolbarEnabled,
    onMarkdownInputIntent,
    isReadOnly
  })

  mountEditorLayoutBindings({
    view,
    host,
    cleanups,
    markUserEdit,
    onRichEditPending,
    reportActiveBlock
  })

  mountEditorContentBindings({
    view,
    docPath,
    crepe,
    cleanups,
    markUserEdit,
    insertUploadedImage,
    prepareRawMarkdownPaste,
    setZoom,
    getT,
    isReadOnly,
    isDestroyed
  })

  mountCodeBlockLanguageInput({ view, cleanups, getT, isReadOnly })
  mountCodeBlockFold({ view, cleanups, getT })
  mountSvgCodeBlockToggle({ view, cleanups, getT })

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
