// Shared pure helpers: paths, filenames, doc classification, session, ids.
// All stateless — no React, no DOM mutation — so safe to import anywhere in the
// renderer. (The main process has its own copies; it can't import this module.)

// Compare dotted versions: is `a` newer than `b`? (e.g. '0.1.5' > '0.1.4')
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
export const sanitizeWorkspace = (ws) => (ws && isAbsolutePath(ws.rootPath) ? ws : null)

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

// A Markdown doc is "heavy" to render richly when it has a huge run of non-blank
// lines (no blank-line paragraph breaks) — Markdown then collapses it into one
// giant paragraph with thousands of inline line-break nodes, and ProseMirror's
// near-quadratic handling of that freezes the main thread for many seconds. Such
// docs open in the fast plain-text editor by default (instant); the user can opt
// into the rich editor per-tab. (Total-size cap is a coarse extra guard.)
const HEAVY_MAX_BLOCK_LINES = 150
const HEAVY_MAX_TOTAL = 400000
export function isHeavyDoc(content) {
  if (!content) return false
  if (content.length > HEAVY_MAX_TOTAL) return true
  let run = 0
  for (const line of content.split('\n')) {
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
