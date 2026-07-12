// Shared pure helpers: paths, filenames, doc classification, session, ids.
// All stateless — no React, no DOM mutation — so safe to import anywhere in the
// renderer. (The main process has its own copies; it can't import this module.)

// Compare dotted versions: is `a` newer than `b`? (e.g. '0.1.5' > '0.1.4')
// Is semver `a` newer than semver `b`? Call as isNewerVersion(latest, current)
// → true when an update is available. (a/b order matters; a flipped call would
// always report "up to date".)
export function isNewerVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

// An absolute path: POSIX "/…", Windows "C:\…"/"C:/…", or a UNC "\\…". A relative
// path like "." would resolve against the process CWD (= "/" under launchd), so a
// workspace must be absolute — otherwise the file tree / watcher target the wrong
// place (and recursively watching "/" crashes the app).
export const isAbsolutePath = (p) =>
  typeof p === 'string' && (/^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p))

export function normalizePathKey(p) {
  let s = String(p || '').replace(/\\/g, '/')
  while (s.length > 1 && !/^[a-zA-Z]:\/$/.test(s) && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Renderer-side mirror of main's isRestrictedRoot: paths we must never treat as
// a workspace folder root. Watching or listing one (/, /dev, /System/Volumes…)
// floods the tree with permission-protected files and crashes the recursive
// chokidar watcher. Kept in sync with src/main/index.js isRestrictedRoot.
export const isRestrictedPath = (p) => {
  const norm = (p || '').replace(/[\\/]+$/, '')
  if (norm === '' || norm === '/' || norm === '.' || norm === '..') return true
  if (!isAbsolutePath(norm)) return true
  return /^\/(dev|proc|System\/Volumes|private\/var\/(db|folders)|\.vol)(\/|$)/.test(norm)
}

// ---- Single-workspace data model ----
// The workspace is the single, unnamed container for the sidebar file tree. It
// holds N folder roots (multi-root tree) — that's it. No name, no multiple
// workspaces, no switching (HorseMD is a writing app, one workspace is enough;
// users add/remove folders within it). Session persists `folderRoots: [abs,…]`.

// Filter to absolute, non-restricted, de-duplicated roots (mirrors main's
// isRestrictedRoot; a relative/restricted root would crash the chokidar watcher).
export function sanitizeFolderRoots(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const p of list) {
    if (typeof p !== 'string' || !isAbsolutePath(p) || isRestrictedPath(p)) continue
    const k = normalizePathKey(p)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

// Migrate the session into a flat folderRoots array. Accepts the current shape
// { folderRoots } plus two legacy shapes (no data loss across upgrades):
//   - { workspaces: [{ folderRoots }] }   (the multi-workspace build) → merge all roots
//   - { workspace: { rootPath } }          (the original single-folder build) → [rootPath]
export function loadFolderRootsFromSession(session) {
  if (!session) return []
  if (Array.isArray(session.folderRoots)) return sanitizeFolderRoots(session.folderRoots)
  if (Array.isArray(session.workspaces)) {
    const all = session.workspaces.flatMap((w) => (w && Array.isArray(w.folderRoots) ? w.folderRoots : []))
    return sanitizeFolderRoots(all)
  }
  const legacy = session.workspace
  if (legacy && isAbsolutePath(legacy.rootPath) && !isRestrictedPath(legacy.rootPath)) {
    return sanitizeFolderRoots([legacy.rootPath])
  }
  return []
}

export const baseName = (p) => (p ? p.split(/[\\/]/).pop() : 'Untitled')
export const dirName = (p) => (p ? p.replace(/[\\/][^\\/]*$/, '') : '')
export const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}/${name}`

// Files that open in the rich Markdown editor. Anything else with a path (e.g.
// .txt) is treated as plain text and opened in the fast textarea — feeding plain
// text through Milkdown collapses its line breaks and bogs down on large files.
export const MD_DOC_RE = /\.(md|markdown|mdx)$/i
export const isMarkdownName = (name) => MD_DOC_RE.test(name || '')
export const isPlainTextDoc = (tab) => !!(tab && tab.path && !MD_DOC_RE.test(tab.path))

// A valid single path-segment name: no separators / reserved chars, not "."/"..".
export const isValidName = (name) => !!name && !/[\\/:*?"<>|]/.test(name) && name !== '.' && name !== '..'
// Does this fs error mean "a file/folder with that name already exists"?
export const isExistsError = (e) => /eexist|already exists/i.test(e?.message || '')

// A Markdown doc is "heavy" to render richly when:
//   ① it has a huge run of non-blank lines (no paragraph breaks) → ProseMirror
//     near-quadratic freeze;
//   ② total chars > 400 K;
//   ③ total lines > 50 K → even with normal blank-line breaks, the sheer number
//     of nodes (50 K+ paragraphs) makes the full parse + DOM render block the
//     main thread for many seconds.
// Such docs open in the fast plain-text editor by default (instant); the user
// can opt into the rich editor per-tab.
const HEAVY_MAX_BLOCK_LINES = 1000
const HEAVY_MAX_TOTAL = 400000
const HEAVY_MAX_LINES = 50000
export function isHeavyDoc(content) {
  if (!content) return false
  if (content.length > HEAVY_MAX_TOTAL) return true
  let run = 0
  let lines = 0
  for (const line of content.split('\n')) {
    if (++lines > HEAVY_MAX_LINES) return true // ← P0-1: line-count guard
    if (/^[ \t]*$/.test(line)) {
      run = 0
    } else if (++run > HEAVY_MAX_BLOCK_LINES) {
      return true
    }
  }
  return false
}

let idCounter = 0
export const genId = () => `t${++idCounter}_${Date.now()}`

export const LS = 'minimd.session.v1'
export const loadSession = () => {
  try {
    return JSON.parse(localStorage.getItem(LS)) || {}
  } catch {
    return {}
  }
}
