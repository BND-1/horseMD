import { dialog } from 'electron'
import { createPdfExportService } from './pdf-export.js'
import { createPandocExportService } from './pandoc-export.js'
import { createHtmlExportService } from './html-export.js'

export function registerDocumentIpc(ipcMain, { getMainWindow, getUserDataPath, markdownExtensions, isTrustedSender }) {
  const pdfExport = createPdfExportService({ getMainWindow })
  const htmlExport = createHtmlExportService({ getMainWindow })
  const pandocExport = createPandocExportService({ getMainWindow, getUserDataPath })
  const trusted = (event) => !isTrustedSender || isTrustedSender(event)
  ipcMain.handle('dialog:openFiles', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
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

  ipcMain.handle('dialog:openFolder', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:saveAs', async (_event, defaultName) => {
    const res = await dialog.showSaveDialog(getMainWindow(), {
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
    ? pandocExport.chooseExecutable()
    : { ok: false, error: 'Untrusted renderer.' })
  ipcMain.handle('pandoc:export', (event, payload) => trusted(event)
    ? pandocExport.exportDocument(payload)
    : { ok: false, error: 'Untrusted renderer.' })
}
