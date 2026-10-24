// Separate Chinese and English document fonts. Checks the fonts Chromium
// actually renders with (CSS.getPlatformFontsForNode), not just the CSS:
// letters use the English font, Chinese characters the Chinese font; an
// unset side keeps the default; an old single "document font" setting
// loads as both (same look as before the split). macOS fonts only.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

if (process.platform !== 'darwin') { console.log('SKIP font CJK/Latin: uses macOS fonts'); process.exit(0) }
const root = `/tmp/horsemd-font-cjk-latin-${process.pid}`
const file = join(root, 'fonts.md')
const port = Number(process.env.CDP_PORT || 9690 + (process.pid % 40))
let app = null

const waitFor = async (check, message, attempts = 80) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const ready = () => waitFor(
  () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((n) => n.offsetParent && n.textContent.includes('中文段落'))`),
  'document did not open'
)
const withSettings = async (values) => {
  const oldOrigin = await app.evaluate('performance.timeOrigin')
  await app.evaluate(`(() => {
    const s = JSON.parse(localStorage.getItem('horsemd.settings.v1') || '{}')
    delete s.fontWrite
    delete s.fontWriteLatin
    localStorage.setItem('horsemd.settings.v1', JSON.stringify({ ...s, ...${JSON.stringify(values)} }))
  })()`)
  await app.send('Page.reload')
  await waitFor(async () => {
    try { return await app.evaluate('performance.timeOrigin') !== oldOrigin } catch { return false }
  }, 'reload did not finish')
  await ready()
  await sleep(400)
}
// Font families used to draw the paragraph that starts with `text`.
const renderedFonts = async (text) => {
  // ProseMirror reverts attributes set on its DOM, so take the node by
  // reference: Runtime object → DOM node id.
  const { result } = (await app.send('Runtime.evaluate', {
    expression: `[...[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent).querySelectorAll('p')].find((p) => p.textContent.startsWith(${JSON.stringify(text)}))`
  })).result
  await app.send('DOM.getDocument', { depth: 0 })
  const { nodeId } = (await app.send('DOM.requestNode', { objectId: result.objectId })).result
  const { fonts } = (await app.send('CSS.getPlatformFontsForNode', { nodeId })).result
  return fonts.map((f) => f.familyName)
}
const check = async (label, latinRe, cjkRe) => {
  const latin = await renderedFonts('Hello')
  const cjk = await renderedFonts('中文段落')
  console.log(label, { latin, cjk })
  assert.ok(latin.length === 1 && latinRe.test(latin[0]), `${label}: letters drawn with ${latin}`)
  assert.ok(cjk.length === 1 && cjkRe.test(cjk[0]), `${label}: Chinese drawn with ${cjk}`)
}

try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# Fonts\n\nHello world fonts\n\n中文段落测试\n')
  app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
  await app.send('Runtime.enable')
  await app.send('DOM.enable')
  await app.send('CSS.enable')
  await ready()

  await check('default', /Helvetica Neue/, /PingFang/)
  await withSettings({ fontWriteLatin: 'Georgia', fontWrite: 'Songti SC' })
  await check('both set', /Georgia/, /Songti/)
  await withSettings({ fontWriteLatin: 'Georgia', fontWrite: '' })
  await check('English only', /Georgia/, /PingFang/)
  await withSettings({ fontWriteLatin: '', fontWrite: 'Songti SC' })
  await check('Chinese only', /Helvetica Neue/, /Songti/)
  // An old single document font (no fontWriteLatin key): both, as before.
  await withSettings({ fontWrite: 'Songti SC' })
  await check('legacy single font', /Songti/, /Songti/)
} finally {
  if (app) await stopBuiltElectron(app)
  await rm(root, { recursive: true, force: true })
}
console.log('PASS font CJK/Latin: English and Chinese document fonts render separately; legacy setting unchanged')
