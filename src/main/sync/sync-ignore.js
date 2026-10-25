// Files the operating system writes into folders on its own (Finder view
// settings, AppleDouble metadata on non-Mac disks, Explorer thumbnails and
// folder settings). They are not notes: syncing them uploads a changed
// .DS_Store every time a folder is opened in Finder (#161's log), and other
// sync tools skip them too (Nextcloud's default exclude list, Syncthing's
// documented `(?d).DS_Store`). Matched by file name only — any other dot
// file (`.config`, `.gitignore`) is the user's and still syncs.
const SYSTEM_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

export function isSystemJunkPath(path) {
  const name = String(path || '').split(/[\\/]/).pop() || ''
  return SYSTEM_FILE_NAMES.has(name.toLowerCase()) || name.startsWith('._')
}
