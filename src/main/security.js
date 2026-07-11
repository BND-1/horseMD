const LOCAL_FONT_PERMISSION_NAMES = new Set(['local-fonts', 'unknown'])

export const LOCAL_FONT_GRANT_TTL_MS = 5000

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
