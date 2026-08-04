import { dirOf, isRelativePath, resolveToFileUrl } from './editor-images.js'

function decodePathOnce(value) {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

// Markdown links can contain an authored POSIX path (`/Users/me/note.md`), a
// Windows drive path (`C:\\Notes\\note.md`), or an UNC path. Browsers do not
// treat those as file URLs by themselves, so normalize them before crossing the
// dedicated, file-only Electron IPC boundary.
export function isAbsoluteLocalPath(value) {
  const path = String(value || '')
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/]/.test(path)
}

export function absolutePathToFileUrl(value) {
  const path = decodePathOnce(String(value || ''))
  if (!path) return null
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    return encodeURI(`file:///${path.replace(/\\/g, '/')}`)
  }
  if (/^\\\\[^\\/]+[\\/]/.test(path)) {
    // UNC: \\server\share\file.md → file://server/share/file.md
    return encodeURI(`file://${path.slice(2).replace(/\\/g, '/')}`)
  }
  if (path.startsWith('/')) return encodeURI(`file://${path}`)
  return null
}

export function resolveLocalLinkToFileUrl(href, docPath) {
  if (!href || href.startsWith('#')) return null
  if (/^file:/i.test(href)) return href
  if (isAbsoluteLocalPath(href)) return absolutePathToFileUrl(href)
  if (!isRelativePath(href)) return null
  const baseDir = dirOf(docPath)
  return baseDir ? resolveToFileUrl(baseDir, href) : null
}
