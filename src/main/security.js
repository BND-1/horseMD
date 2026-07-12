const LOCAL_FONT_PERMISSION_NAMES = new Set(['local-fonts', 'unknown'])
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

export const LOCAL_FONT_GRANT_TTL_MS = 5000

export function getAllowedExternalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value)
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

export function createLocalFontGrant(webContentsId, now = Date.now()) {
  return {
    webContentsId,
    expiresAt: now + LOCAL_FONT_GRANT_TTL_MS
  }
}

export function isTrustedRendererUrl(candidate, currentUrl, devRendererUrl = '') {
  try {
    const requested = new URL(candidate)
    const current = new URL(currentUrl)
    if (devRendererUrl) {
      const dev = new URL(devRendererUrl)
      return requested.origin === dev.origin && current.origin === dev.origin
    }
    if (requested.protocol !== 'file:' || current.protocol !== 'file:') return false
    // Permission checks may report the opaque file:// origin without a path.
    return !requested.pathname || requested.pathname === '/' || requested.pathname === current.pathname
  } catch {
    return false
  }
}

export function canGrantLocalFonts({
  permission,
  webContentsId,
  trustedWebContentsId,
  requestingUrl,
  currentUrl,
  devRendererUrl,
  isMainFrame,
  grant,
  now = Date.now()
}) {
  return LOCAL_FONT_PERMISSION_NAMES.has(permission) &&
    webContentsId === trustedWebContentsId &&
    isMainFrame === true &&
    grant?.webContentsId === trustedWebContentsId &&
    grant.expiresAt >= now &&
    isTrustedRendererUrl(requestingUrl, currentUrl, devRendererUrl)
}
