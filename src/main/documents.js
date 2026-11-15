import { BrowserWindow, dialog } from 'electron'
import { createPdfExportService } from './pdf-export.js'
import { createPandocExportService } from './pandoc-export.js'
import { createHtmlExportService } from './html-export.js'

export function registerDocumentIpc(ipcMain, { getMainWindow, getUserDataPath, markdownExtensions, isTrustedSender }) {
  // Dialogs belong to the window that asked (main or a secondary window).
  const getParentWindow = (event) => {
    const sender = event?.sender
    const win = sender && !sender.isDestroyed?.() ? BrowserWindow.fromWebContents(sender) : null
    return win && !win.isDestroyed() ? win : getMainWindow()
  }
  const pdfExport = createPdfExportService({ getMainWindow, getParentWindow })
  const htmlExport = createHtmlExportService({ getMainWindow, getParentWindow })
  const pandocExport = createPandocExportService({ getMainWindow, getParentWindow, getUserDataPath })
  const trusted = (event) => !isTrustedSender || isTrustedSender(event)
  ipcMain.handle('dialog:openFiles', async (event) => {
    const res = await dialog.showOpenDialog(getParentWindow(event), {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown', extensions: markdownExtensions },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:openAttachments', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Attach Files'
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('dialog:openFolder', async (event) => {
    const res = await dialog.showOpenDialog(getParentWindow(event), { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:saveAs', async (event, defaultName) => {
    const res = await dialog.showSaveDialog(getParentWindow(event), {
      defaultPath: defaultName || 'Untitled.md',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
    })
    return res.canceled ? null : res.filePath
  })

  ipcMain.handle('pdf:preview', (event, payload) => trusted(event)
    ? pdfExport.createPreview(event, payload)
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('pdf:savePreview', (event, payload) => trusted(event)
    ? pdfExport.savePreview(event, payload)
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('pdf:disposePreview', (event, token) => trusted(event)
    ? pdfExport.disposePreview(event, token)
    : false)
  ipcMain.handle('html:preview', (event, payload) => trusted(event)
    ? htmlExport.createPreview(event, payload)
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('html:savePreview', (event, payload) => trusted(event)
    ? htmlExport.savePreview(event, payload)
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('html:disposePreview', (event, token) => trusted(event)
    ? htmlExport.disposePreview(event, token)
    : false)
  ipcMain.handle('pandoc:detect', (event) => trusted(event)
    ? pandocExport.detect()
    : { available: false, path: null, version: null, error: 'Untrusted renderer.' })
  ipcMain.handle('pandoc:selectExecutable', (event) => trusted(event)
    ? pandocExport.chooseExecutable(event)
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('pandoc:export', (event, payload) => trusted(event)
    ? pandocExport.exportDocument(payload, event)
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('pandoc:openResult', (event, kind) => trusted(event)
    ? pandocExport.openResult(kind === 'folder' ? 'folder' : 'file', event)
    : { ok: false, error: 'Untrusted renderer.' })
}
