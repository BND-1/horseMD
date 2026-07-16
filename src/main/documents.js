import { dialog } from 'electron'
import { createPdfExportService } from './pdf-export.js'

export function registerDocumentIpc(ipcMain, { getMainWindow, markdownExtensions }) {
  const pdfExport = createPdfExportService({ getMainWindow })
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

  ipcMain.handle('pdf:preview', (event, payload) => pdfExport.createPreview(event, payload))
  ipcMain.handle('pdf:savePreview', (event, payload) => pdfExport.savePreview(event, payload))
  ipcMain.handle('pdf:disposePreview', (event, token) => pdfExport.disposePreview(event, token))
}
