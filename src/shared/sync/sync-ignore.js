// Files the operating system writes into folders on its own (Finder view
// settings, AppleDouble metadata on non-Mac disks, Explorer thumbnails and
// folder settings). They are not notes: syncing them uploads a changed
// .DS_Store every time a folder is opened in Finder (#161's log), and other
// sync tools skip them too (Nextcloud's default exclude list, Syncthing's
// documented `(?d).DS_Store`). Matched by file name only — any other dot
// file (`.config`, `.gitignore`) is the user's and still syncs.
const SYSTEM_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

// Also HorseMD's own in-flight temp files: the editor's atomic save
// (`.name.<pid>.<t>.hmtmp`) and the sync's download (`name.<pid>.<uuid>.tmp`) —
// a scan that runs during a save must not upload half a write.
const TEMP_FILE = /(?:\.hmtmp|\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp)$/i

export function isSystemJunkPath(path) {
  const name = String(path || '').split(/[\\/]/).pop() || ''
  return SYSTEM_FILE_NAMES.has(name.toLowerCase()) || name.startsWith('._') || TEMP_FILE.test(name)
}
