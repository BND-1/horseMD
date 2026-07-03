import { contextBridge, ipcRenderer, webFrame } from 'electron'

// Subscribe to a main→renderer channel; returns an unsubscribe function.
const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

const api = {
  // dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  saveAs: (defaultName) => ipcRenderer.invoke('dialog:saveAs', defaultName),
  exportPDF: (html, defaultName) => ipcRenderer.invoke('export:pdf', { html, defaultName }),

  // fs
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
  rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  deleteItem: (path) => ipcRenderer.invoke('fs:delete', path),
  createFile: (path, content) => ipcRenderer.invoke('fs:createFile', path, content),
  createDir: (path) => ipcRenderer.invoke('fs:createDir', path),
  duplicate: (path) => ipcRenderer.invoke('fs:duplicate', path),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
  openFolderTree: (dir) => ipcRenderer.invoke('fs:openFolderTree', dir),

  // watch
  watchStart: (dir) => ipcRenderer.invoke('watch:start', dir),
  watchStop: (dir) => ipcRenderer.invoke('watch:stop', dir),
  watchFile: (path) => ipcRenderer.invoke('watch:file', path),
  unwatchFile: (path) => ipcRenderer.invoke('watch:unfile', path),

  // shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),

  // image host: write the bytes to a temp file, run the user's upload command on
  // it, and return the URL it prints. Returns { ok, url } or { ok:false, error }.
  uploadImage: (command, name, bytes) =>
    ipcRenderer.invoke('image:upload', command, name, bytes),

  // save a pasted/dropped image into the document's assets/ folder (no image
  // host); returns { ok, path } with a relative path to insert into Markdown.
  saveImage: (docPath, name, bytes) =>
    ipcRenderer.invoke('image:save', docPath, name, bytes),
  // save an image pasted into an UNSAVED doc to the global paste folder; returns
  // { ok, url } (a file:// URL) so it shows as a real path, not a base64 blob.
  savePaste: (name, bytes) => ipcRenderer.invoke('image:savePaste', name, bytes),
  // at save time, move base64 / paste-folder images into the doc's assets/ and
  // rewrite the Markdown to relative paths; returns { content, changed }.
  inlineForSave: (content, targetPath) =>
    ipcRenderer.invoke('image:inlineForSave', content, targetPath),

  // custom themes (user CSS files in userData/themes)
  themesList: () => ipcRenderer.invoke('themes:list'),
  themeRead: (file) => ipcRenderer.invoke('themes:read', file),
  themesReveal: () => ipcRenderer.invoke('themes:reveal'),

  // window controls (custom title-bar buttons on Windows/Linux)
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // update check (notify-only)
  checkUpdate: () => ipcRenderer.invoke('update:check'),

  // app close: main asks before closing so the renderer can warn about unsaved
  // changes, then calls confirmAppClose() to proceed or cancelAppClose() to abort.
  confirmAppClose: () => ipcRenderer.send('app:confirm-close'),
  cancelAppClose: () => ipcRenderer.send('app:cancel-close'),

  // events from main
  onOpenPaths: on('open-paths'),
  onOpenFolderPath: on('open-folder'),
  onMenu: on('menu'),
  onWatchChanged: on('watch:changed'),
  onFileChanged: on('file:changed'),
  onWindowMaximized: on('window:maximized'),
  onAppCloseRequest: on('app-close-request'),

  setZoomFactor: (f) => webFrame.setZoomFactor(f),
  getZoomFactor: () => webFrame.getZoomFactor(),

  platform: process.platform,

  // Feature capabilities for the renderer to gate UI uniformly across desktop /
  // mobile (mobile provides its own set via the Capacitor shim). Exposed HERE,
  // not added later in the renderer: contextBridge freezes this object, so
  // assigning `window.api.capabilities` from the renderer throws ("object is not
  // extensible") and white-screens the app. Desktop supports everything.
  capabilities: {
    folderWorkspace: true,
    watch: true,
    windowControls: true,
    pdfExport: true,
    imageHostExec: true,
    nativeMenus: true,
    externalShell: true,
    revealInFolder: true,
    splitView: true
  }
}

contextBridge.exposeInMainWorld('api', api)
