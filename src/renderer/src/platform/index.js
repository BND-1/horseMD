// Install the platform bridge BEFORE React mounts.
//
// On desktop, Electron's preload has already set window.api, so this is a no-op.
// On mobile (Capacitor) there is no preload, so we build the same API surface
// from Capacitor plugins. main.jsx imports this first so window.api exists by
// the time App renders (App reads window.api.platform during render).
//
// We also expose a `capabilities` object regardless of platform: desktop fills
// in a full set so the renderer can gate features uniformly without sniffing
// platform strings everywhere.
import { makeCapacitorApi } from './capacitor-api.js'

const DESKTOP_CAPABILITIES = {
  folderWorkspace: true,
  watch: true,
  windowControls: true,
  pdfExport: true,
  imageHostExec: true,
  nativeMenus: true,
  externalShell: true,
  revealInFolder: true,
  splitView: true,
  nativeDropOpen: true
}

if (typeof window !== 'undefined') {
  if (!window.api) {
    // Mobile / web: no Electron preload — back the contract with Capacitor.
    window.api = makeCapacitorApi()
  } else if (!window.api.capabilities) {
    // Desktop: the preload normally exposes capabilities directly (its object is
    // frozen by contextBridge, so it must). This branch is a defensive fallback
    // for an older preload — guarded because assigning to the frozen api object
    // throws ("object is not extensible") and would white-screen the app.
    try {
      window.api.capabilities = DESKTOP_CAPABILITIES
    } catch {
      /* frozen api without capabilities — features fail open (treated as available) */
    }
  }
}
