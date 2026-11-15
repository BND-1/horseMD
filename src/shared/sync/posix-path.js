// POSIX path functions for the shared sync code (no node:path in a WebView).
// normalize / join / dirname / basename / extname are a faithful port of
// Node's `path.posix` (lib/path.js), so the plan computes exactly the names
// it computed with node:path/posix (conflict copies are compared by name
// across devices). Paths here always use '/'.

const SLASH = 47
const DOT = 46

function normalizeString(path, allowAboveRoot) {
  let res = ''
  let lastSegmentLength = 0
  let lastSlash = -1
  let dots = 0
  let code = 0
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i)
    else if (code === SLASH) break
    else code = SLASH
    if (code === SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/')
            if (lastSlashIndex === -1) {
              res = ''
              lastSegmentLength = 0
            } else {
              res = res.slice(0, lastSlashIndex)
              lastSegmentLength = res.length - 1 - res.lastIndexOf('/')
            }
            lastSlash = i
            dots = 0
            continue
          } else if (res.length !== 0) {
            res = ''
            lastSegmentLength = 0
            lastSlash = i
            dots = 0
            continue
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..'
          lastSegmentLength = 2
        }
      } else {
        if (res.length > 0) res += `/${path.slice(lastSlash + 1, i)}`
        else res = path.slice(lastSlash + 1, i)
        lastSegmentLength = i - lastSlash - 1
      }
      lastSlash = i
      dots = 0
    } else if (code === DOT && dots !== -1) {
      ++dots
    } else {
      dots = -1
    }
  }
  return res
}

export function normalize(path) {
  if (path.length === 0) return '.'
  const isAbsolute = path.charCodeAt(0) === SLASH
  const trailingSeparator = path.charCodeAt(path.length - 1) === SLASH
  let out = normalizeString(path, !isAbsolute)
  if (out.length === 0) {
    if (isAbsolute) return '/'
    return trailingSeparator ? './' : '.'
  }
  if (trailingSeparator) out += '/'
  return isAbsolute ? `/${out}` : out
}

export function join(...args) {
  let joined
  for (const arg of args) {
    if (arg.length > 0) joined = joined === undefined ? arg : `${joined}/${arg}`
  }
  return joined === undefined ? '.' : normalize(joined)
}

export function dirname(path) {
  if (path.length === 0) return '.'
  const hasRoot = path.charCodeAt(0) === SLASH
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) { end = i; break }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? '/' : '.'
  if (hasRoot && end === 1) return '//'
  return path.slice(0, end)
}

export function basename(path, suffix) {
  let start = 0
  let end = -1
  let matchedSlash = true
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return ''
    let extIdx = suffix.length - 1
    let firstNonSlashEnd = -1
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i)
      if (code === SLASH) {
        if (!matchedSlash) { start = i + 1; break }
      } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1 }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i
          } else {
            extIdx = -1
            end = firstNonSlashEnd
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd
    else if (end === -1) end = path.length
    return path.slice(start, end)
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) { start = i + 1; break }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  return end === -1 ? '' : path.slice(start, end)
}

export function extname(path) {
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  let preDotState = 0
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i)
    if (code === SLASH) {
      if (!matchedSlash) { startPart = i + 1; break }
      continue
    }
    if (end === -1) { matchedSlash = false; end = i + 1 }
    if (code === DOT) {
      if (startDot === -1) startDot = i
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return ''
  }
  return path.slice(startDot, end)
}

// ---- Root-relative helpers for platforms whose roots are POSIX strings
// (the phone library "HorseMD", or "/var/…/Documents/HorseMD"). The desktop
// keeps node:path semantics in src/main/sync/node-platform.js.

const trimRoot = (root) => {
  const value = String(root || '').replace(/\\/g, '/')
  const out = value.length > 1 ? value.replace(/\/+$/, '') : value
  return out
}

// `root`/`rel` when `rel` stays strictly inside `root`, else null (empty,
// "..", the root itself). Mirrors the desktop check in the sync engine.
export function resolveInside(root, rel) {
  const base = normalize(trimRoot(root) || '.')
  const relative = String(rel ?? '').replace(/\\/g, '/')
  if (!relative || relative.startsWith('/')) return null
  const inner = normalize(relative)
  if (inner === '.' || inner === './' || inner === '..' || inner.startsWith('../')) return null
  const clean = inner.replace(/\/+$/, '')
  if (!clean || clean === '.') return null
  return base === '.' ? clean : base === '/' ? `/${clean}` : `${base}/${clean}`
}

// Path of `path` relative to `root` ('/'-joined), or null when it is not
// strictly inside `root`.
export function relativeInside(root, path) {
  if (typeof path !== 'string') return null
  const base = normalize(trimRoot(root) || '.').replace(/\/+$/, '')
  const target = normalize(path.replace(/\\/g, '/')).replace(/\/+$/, '')
  if (!base || base === '.' || !target.startsWith(`${base}/`)) return null
  const rel = target.slice(base.length + 1)
  if (!rel || rel === '..' || rel.startsWith('../')) return null
  return rel
}
