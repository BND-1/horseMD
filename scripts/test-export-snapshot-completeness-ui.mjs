import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { chooseContextExportFormat } from './lib/context-menu.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-export-snapshot-'))
const file = join(root, 'snapshot.md')
const code = Array.from({ length: 122 }, (_, i) => i === 59 ? '' : `CODE_LINE_${String(i + 1).padStart(3, '0')}`).join('\n') + '\n'
const original = '# SNAPSHOT\n\nSOFT_FIRST\nSOFT_SECOND\n\n```text\n' + code + '\n```\n\nDOCUMENT_END\n'
await writeFile(file, original)
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), cleanProfile: false, port: 36000 + process.pid % 1000, appArgs: [file, '--horsemd-input-trace'] })
try {
  let loaded = false
  for (let i = 0; i < 120; i++) {
    loaded = await app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find(n=>n.offsetParent)?.textContent.includes('DOCUMENT_END')`)
    if (loaded) break
    await sleep(80)
  }
  assert.ok(loaded)
  await app.evaluate('window.__HORSEMD_TEST_CAPTURE_PDF__ = true')
  const point = await app.evaluate(`(() => { const tab=[...document.querySelectorAll('.tab')].find(n=>n.offsetParent && n.textContent.includes('snapshot.md')); const r=tab?.getBoundingClientRect(); return r ? {x:r.left+r.width/2,y:r.top+r.height/2} : null })()`)
  assert.ok(point, 'fixture tab missing')
  for (const type of ['mousePressed','mouseReleased']) await app.send('Input.dispatchMouseEvent', {type,...point,button:'right',clickCount:1})
  await chooseContextExportFormat(app.evaluate, 'PDF')
  let captured
  for (let i = 0; i < 150; i++) {
    captured = await app.evaluate('window.__horsemdLastPdfPreview || null')
    if (captured?.source?.html) break
    await sleep(100)
  }
  assert.ok(captured?.source?.html, 'PDF command did not capture the shared export snapshot')
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(captured, null, 2))
  const html = captured.source.html
  assert.ok(html.includes('CODE_LINE_001'))
  assert.ok(html.includes('CODE_LINE_122'), 'virtualized code tail is absent from export')
  const rows = (html.match(/class="hm-code-line-text"/g) || []).length
  assert.equal(rows, code.split('\n').length, 'complete code lines, including empty last line, must be exported')
  if (!process.env.EXPORT_CODE_ONLY) assert.match(html, /SOFT_FIRST<br\s*\/?>(?:<\/span>)?SOFT_SECOND/, 'visible soft line break must survive the export clone')
  assert.equal(await readFile(file, 'utf8'), original)
  console.log('PASS export snapshot:', process.env.EXPORT_CODE_ONLY ? 'full code only' : 'full code and soft break', '; unchanged source; evidence:', root)
} finally { await stopBuiltElectron(app) }
