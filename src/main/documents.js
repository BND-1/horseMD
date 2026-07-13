import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import fs from 'node:fs/promises'
import { buildPdfDocument, resolvePdfPage } from './pdf-document.js'

export function registerDocumentIpc(ipcMain, { getMainWindow, markdownExtensions }) {
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

  ipcMain.handle('export:pdf', async (_event, { html, defaultName, options }) => {
    const page = resolvePdfPage(options)
    const res = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: defaultName || 'Untitled.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true }

    const tmp = join(app.getPath('temp'), `horsemd-export-${Date.now()}.html`)
    await fs.writeFile(tmp, buildPdfDocument(html, page), 'utf8')
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The temporary file must load local images referenced by the document.
        webSecurity: false
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    try {
      await win.loadFile(tmp)
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: page.printPageSize
      })
      await fs.writeFile(res.filePath, pdf)
    } finally {
      if (!win.isDestroyed()) win.destroy()
      fs.unlink(tmp).catch(() => {})
    }
    shell.openPath(res.filePath)
    return { path: res.filePath }
  })
}
