import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-fast-empty-bullet-ordered-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11440 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = [
  '# 快速 ordered input-rule 回归', '',
  '- 看了你快乐呢',
  '- ', '',
  '2. 斛律v哦', '',
  '```txt', '尼玛，吗了解', '了几百块', '```', ''
].join('\n')

const waitFor = async (check, message, attempts = 160) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const key = async (app, keyValue, code, keyCode, text = keyValue, after = 18) => {
  const common = { key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, ...e }) => e),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...e }) => ({
    ...e,
    candidate: String(e.candidate || '').slice(0, 500),
    canonical: String(e.canonical || '').slice(0, 500)
  })),
  toasts: [...document.querySelectorAll('[class*="toast"]')].map((n) => n.textContent || '')
}))()`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await launchBuiltElectron({
    profileDir: join(root, 'profile'),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })

  await waitFor(() => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
    .find((n) => n.offsetParent && n.textContent.includes('看了你快乐呢') && n.textContent.includes('斛律v哦')))`), 'fixture did not mount')
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
    const p = [...editor.querySelectorAll('li p')].find((n) => !(n.textContent || '').trim())
    const sel = getSelection(); sel.removeAllRanges()
    const range = document.createRange(); range.selectNodeContents(p); range.collapse(false); sel.addRange(range)
    editor.focus(); document.dispatchEvent(new Event('selectionchange'))
  })()`)

  // Critical cadence from PID 49164: period and Space arrive before the
  // serializer has published an independent `1\\.` frame.
  await key(app, '1', 'Digit1', 49, '1', 18)
  await key(app, '.', 'Period', 190, '.', 6)
  await key(app, ' ', 'Space', 32, ' ', 18)
  await sleep(900)

  const transient = await diagnostics(app)
  console.log('FAST_ORDERED_TRANSIENT:', JSON.stringify(transient))
  assert.equal(transient.integrity.some((e) => e.ok === false), false, 'fast 1. Space frame failed source integrity')
  assert.equal(transient.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'fast 1. Space frame showed warning')
  // A simple document may safely stay on the older batched-list-row path;
  // the dedicated diverged bridge is only required once authored/canonical
  // list structure has accumulated the larger real-world divergence. Assert
  // the contract, not a particular safe internal path.
  assert.equal(transient.integrity.some((e) =>
    e.semanticOk === true &&
    e.listSlotsMatch === true &&
    (e.candidate.includes('\n- 1. \n\n2. 斛律v哦') || e.candidate.includes('\n-   1. \n\n2. 斛律v哦'))
  ), true, 'fast coalesced frame did not persist a source-equivalent temporary ordered slot')

  await key(app, '测', 'KeyA', 65, '测', 40)
  await sleep(1000)
  const continued = await diagnostics(app)
  console.log('FAST_ORDERED_CONTINUED:', JSON.stringify(continued))
  assert.equal(continued.integrity.some((e) => e.ok === false), false, 'continuing after fast ordered frame failed integrity')
  assert.equal(continued.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'continuing after fast ordered frame showed warning')
  assert.equal(continued.integrity.some((e) =>
    e.semanticOk === true && e.listSlotsMatch === true && /\n- (?:1\\\. 测|1\. 测|   1\. 测)\n\n2\. 斛律v哦/.test(e.candidate)
  ), true, 'continued source did not remain structurally equivalent after body text')
  assert.equal(continued.integrity.some((e) => e.candidate.includes('```txt\n尼玛，吗了解\n了几百块\n```')), true, 'authored fence changed')
  console.log('PASS fast empty bullet -> 1 -> . -> Space -> text stays source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
