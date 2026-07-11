import assert from 'node:assert/strict'
import {
  LOCAL_FONT_GRANT_TTL_MS,
  canGrantLocalFonts,
  createLocalFontGrant,
  isTrustedRendererUrl
} from '../src/main/security.js'

const now = 1000
const trustedWebContentsId = 7
const currentUrl = 'file:///Applications/HorseMD.app/Contents/Resources/app.asar/out/renderer/index.html'
const grant = createLocalFontGrant(trustedWebContentsId, now)
const base = {
  permission: 'local-fonts',
  webContentsId: trustedWebContentsId,
  trustedWebContentsId,
  requestingUrl: currentUrl,
  currentUrl,
  isMainFrame: true,
  grant,
  now
}

assert.equal(canGrantLocalFonts(base), true, 'allows an explicit local-font request from the main frame')
assert.equal(canGrantLocalFonts({ ...base, permission: 'unknown' }), true, 'supports Electron 34 unknown mapping')
assert.equal(canGrantLocalFonts({ ...base, permission: 'media' }), false, 'rejects unrelated permissions')
assert.equal(canGrantLocalFonts({ ...base, webContentsId: 8 }), false, 'rejects another window')
assert.equal(canGrantLocalFonts({ ...base, isMainFrame: false }), false, 'rejects subframes')
assert.equal(canGrantLocalFonts({ ...base, now: now + LOCAL_FONT_GRANT_TTL_MS + 1 }), false, 'rejects expired grants')
assert.equal(canGrantLocalFonts({ ...base, grant: null }), false, 'requires an explicit renderer grant')
assert.equal(canGrantLocalFonts({ ...base, requestingUrl: 'https://example.com/' }), false, 'rejects another origin')
assert.equal(isTrustedRendererUrl('http://localhost:5173/settings', 'http://localhost:5173/', 'http://localhost:5173'), true)
assert.equal(isTrustedRendererUrl('http://127.0.0.1:5173/', 'http://localhost:5173/', 'http://localhost:5173'), false)

console.log('PASS main security: local-font permission is scoped to the trusted main frame')
