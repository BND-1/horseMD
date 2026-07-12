import assert from 'node:assert/strict'
import {
  LOCAL_FONT_GRANT_TTL_MS,
  canGrantLocalFonts,
  createLocalFontGrant,
  getAllowedExternalUrl,
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

assert.equal(getAllowedExternalUrl('https://horsemd.yangsir.net/docs?q=1'), 'https://horsemd.yangsir.net/docs?q=1')
assert.equal(getAllowedExternalUrl('http://127.0.0.1:36677/image.png'), 'http://127.0.0.1:36677/image.png')
assert.equal(getAllowedExternalUrl('mailto:hello@example.com'), 'mailto:hello@example.com')
assert.equal(getAllowedExternalUrl('file:///tmp/document.md'), null, 'file URLs use the dedicated file handler')
assert.equal(getAllowedExternalUrl('javascript:alert(1)'), null)
assert.equal(getAllowedExternalUrl('data:text/html,unsafe'), null)
assert.equal(getAllowedExternalUrl('horsemd://unsafe'), null)
assert.equal(getAllowedExternalUrl('not a url'), null)

console.log('PASS main security: scoped permissions and external URL protocols')
