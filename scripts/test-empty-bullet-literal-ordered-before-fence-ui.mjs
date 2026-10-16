import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-empty-bullet-literal-ordered-fence-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11120 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = [
  '# 空 bullet literal marker 回归', '',
  '- u高科技',
  '- ', '',
  '```txt', '尼玛，吗了解', '了几百块', '```', '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客', ''
].join('\n')

const waitFor = async (check, message, attempts = 160) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const rawKey = async (app, key, code, keyCode, text = key) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  if (text) await app.send('Input.dispatchKeyEvent', { type: 'char', ...common, text, unmodifiedText: text })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(140)
}

const focusEmptyBullet = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && node.textContent.includes('u高科技') && node.textContent.includes('尼玛，吗了解'))
    if (!editor) return { ok: false, reason: 'editor' }
    const target = [...editor.querySelectorAll('li')].find((li) => {
      const p = li.querySelector('p')
      return p && !(p.textContent || '').trim()
    })
    const p = target?.querySelector('p')
    if (!p) return { ok: false, reason: 'empty-bullet' }
    const sel = getSelection(); sel.removeAllRanges()
    const range = document.createRange(); range.selectNodeContents(p); range.collapse(false); sel.addRange(range)
    editor.focus(); document.dispatchEvent(new Event('selectionchange'))
    return { ok: true }
  })()`)
  assert.equal(result.ok, true, JSON.stringify(result))
}

const diagnostics = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-16).map(({ source, previous, next, ...e }) => e),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-16).map(({ parsed, expected, ...e }) => ({
    ...e,
    candidate: String(e.candidate || '').slice(0, 700),
    canonical: String(e.canonical || '').slice(0, 700)
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
    .find((n) => n.offsetParent && n.textContent.includes('u高科技') && n.textContent.includes('尼玛，吗了解')))`), 'fixture did not mount')
  await app.evaluate(`(() => { window.__hmPreserveLog = []; window.__hmSourceIntegrityTrace = [] })()`)
  await focusEmptyBullet(app)
  await rawKey(app, '1', 'Digit1', 49, '1')
  await rawKey(app, '.', 'Period', 190, '.')
  await sleep(900)

  const literal = await diagnostics(app)
  console.log('EMPTY_BULLET_LITERAL_STATE:', JSON.stringify(literal))
  assert.equal(literal.integrity.some((e) => e.ok === false), false, 'literal 1. failed source integrity')
  assert.equal(literal.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'literal 1. showed warning')
  assert.equal(literal.integrity.some((e) => e.candidate.includes('\n- 1\\.\n\n```txt')), true, 'candidate did not keep - 1\\. literal spelling')

  await rawKey(app, ' ', 'Space', 32, ' ')
  // Do not type the next character immediately. The 0.13.82 real trace failed
  // in this exact space-only synchronization frame before IME composition
  // started, so the regression must force that frame to publish independently.
  await sleep(1050)
  const spaceOnly = await diagnostics(app)
  console.log('EMPTY_BULLET_SPACE_ONLY_STATE:', JSON.stringify(spaceOnly))
  assert.equal(spaceOnly.integrity.some((e) => e.ok === false), false, 'space-only ordered input-rule frame failed source integrity')
  assert.equal(spaceOnly.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'space-only ordered input-rule frame showed warning')
  assert.equal(spaceOnly.preserve.some((e) => e.reason === 'diverged-inline-ordered-input-rule' && e.preserved === true), true, 'space-only frame did not use the reversible inline ordered input-rule bridge')
  assert.equal(spaceOnly.integrity.some((e) => e.candidate.includes('\n-   1. \n\n```txt')), true, 'space-only authored source did not encode the temporary nested ordered slot')

  await rawKey(app, '测', 'KeyA', 65, '测')
  await sleep(1000)
  const continued = await diagnostics(app)
  console.log('EMPTY_BULLET_CONTINUED_STATE:', JSON.stringify(continued))
  assert.equal(continued.integrity.some((e) => e.ok === false), false, 'continuing after literal marker failed source integrity')
  assert.equal(continued.toasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(t)), false, 'continuing after literal marker showed warning')
  assert.equal(continued.integrity.some((e) => e.candidate.includes('\n- 1\\. 测\n\n```txt')), true, 'continued authored source did not restore - 1\\. 测 literal spelling')
  assert.equal(continued.integrity.some((e) => e.candidate.includes('```txt\n尼玛，吗了解\n了几百块\n```')), true, 'authored fence changed')
  console.log('PASS empty bullet -> literal 1. -> isolated space input-rule -> continued text stays source-equivalent')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
