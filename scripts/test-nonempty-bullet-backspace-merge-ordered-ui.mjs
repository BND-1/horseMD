import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-nonempty-bullet-merge-ordered-${process.pid}`
const file = join(root, 'fixture.md')
const port = Number(process.env.CDP_PORT || 11730 + (process.pid % 40))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''

const fixture = [
  '# 非空 bullet Backspace 并入 ordered 回归',
  '',
  '- 看了呢分',
  '',
  '2. 斛律v哦',
  '',
  '- u高科技',
  '- 1\\. 色粉色分',
  '',
  '1. 啊额法色饭',
  '   1. 微风',
  '',
  '```',
  '尼玛，吗了解',
  '了几百块',
  '```',
  '',
  '1',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  ''
].join('\n')
const expected = fixture
  .replace(
    '2. 斛律v哦\n\n- u高科技\n- 1\\. 色粉色分',
    '2. 斛律v哦\n\n3. u高科技\n4. 1\\. 色粉色分'
  )
  .replace('1. 啊额法色饭\n   1. 微风', '1) 啊额法色饭\n   1. 微风')

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const key = async (app, keyValue, code, keyCode, after = 120) => {
  const common = { key: keyValue, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(after)
}

const openApp = async (profile, appPort) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && node.textContent.includes('斛律v哦') && node.textContent.includes('二哥你来拿如果')))`),
    'fixture did not mount'
  )
  return app
}

const focusStartOfBullet = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return false
  for (const item of [...editor.querySelectorAll('ul li')]) {
    const paragraph = item.querySelector(':scope > .children > .content-dom > p') || item.querySelector('p')
    if (!paragraph || (paragraph.textContent || '').trim() !== 'u高科技') continue
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  }
  return false
})()`)

const documentShape = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const item = (text) => [...(editor?.querySelectorAll('li') || [])].find((node) => {
    const paragraph = [...node.querySelectorAll('p')]
      .find((candidate) => candidate.closest('li') === node)
    return (paragraph?.textContent || '').trim() === text
  })
  const left = item('斛律v哦')
  const first = item('u高科技')
  const second = item('1. 色粉色分')
  const following = item('啊额法色饭')
  const child = item('微风')
  const mergedList = left?.closest('ol') || null
  const directText = (node) => ([...node?.querySelectorAll('p') || []]
    .find((candidate) => candidate.closest('li') === node)?.textContent || '').trim()
  return {
    merged: !!mergedList && first?.closest('ol') === mergedList && second?.closest('ol') === mergedList,
    followingSeparate: !!following && following.closest('ol') !== mergedList,
    childNestedUnderFollowing: !!child && child.closest('ol')?.closest('li') === following,
    mergedText: [left, first, second].map(directText)
  }
})()`)

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)
const pauseToasts = (app) => app.evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /检测到富文本与源码不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/.test(text))
`)

let app
try {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture, 'utf8')
  app = await openApp('edit', port)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmSourceIntegrityTrace = []
    window.__hmSourceIntegrityDiffTrace = []
  })()`)

  assert.equal(await focusStartOfBullet(app), true, 'could not focus the start of u高科技')
  await key(app, 'Backspace', 'Backspace', 8, 260)
  await waitFor(
    () => app.evaluate(`(window.__hmPreserveLog || []).some((entry) =>
      entry.reason === 'diverged-nonempty-bullet-list-backspace-merge-ordered')`),
    'Backspace did not hit the non-empty bullet-list merge owner'
  )
  await sleep(700)

  const state = await app.evaluate(`(() => ({
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ source, previous, next, ...entry }) => entry),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => entry)
  }))()`)
  assert.ok(
    state.preserve.some((entry) =>
      entry.reason === 'diverged-nonempty-bullet-list-backspace-merge-ordered' &&
      entry.preserved === true
    ),
    `merge owner did not preserve the callback: ${JSON.stringify(state.preserve)}`
  )
  assert.equal(
    state.integrity.some((entry) => entry.ok === false),
    false,
    `merge produced first-divergence integrity failure: ${JSON.stringify(state.integrity)}`
  )
  assert.ok(
    state.integrity.some((entry) =>
      entry.preservationReason === 'diverged-nonempty-bullet-list-backspace-merge-ordered' &&
      entry.semanticOk === true &&
      entry.listSlotsMatch === true &&
      entry.ok === true
    ),
    `merge candidate was not fully source-equivalent: ${JSON.stringify(state.integrity)}`
  )
  assert.deepEqual(await pauseToasts(app), [], 'merge showed a source-sync warning')
  assert.deepEqual(await documentShape(app), {
    merged: true,
    followingSeparate: true,
    childNestedUnderFollowing: true,
    mergedText: ['斛律v哦', 'u高科技', '1. 色粉色分']
  })

  assert.equal(await toggleSource(app), true, 'source toggle failed')
  const source = await waitFor(() => visibleSource(app), 'source textarea did not open')
  assert.equal(source, expected, 'source mode did not contain the exact authored marker-only patch')
  assert.ok(source.includes('1) 啊额法色饭\n   1. 微风'), 'following list separator or nested child was written incorrectly')
  assert.ok(source.includes('```\n尼玛，吗了解\n了几百块\n```'), 'unrelated fence changed')
  assert.ok(source.includes('-   1. 二哥你来拿如果\n  - \u200B     就了解了呢\n  * 如果可能老顾客'), 'unrelated diverged list changed')

  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
  assert.equal(await readFile(file, 'utf8'), expected, 'saved bytes differ from the source candidate')

  await stopBuiltElectron(app, { removeProfile: true })
  app = await openApp('reopen', port + 1)
  assert.deepEqual(await documentShape(app), {
    merged: true,
    followingSeparate: true,
    childNestedUnderFollowing: true,
    mergedText: ['斛律v哦', 'u高科技', '1. 色粉色分']
  }, 'cold reopen changed the merged/following list structure')
  assert.equal(await toggleSource(app), true, 'source toggle failed after cold reopen')
  assert.equal(await waitFor(() => visibleSource(app), 'source missing after cold reopen'), expected)
  assert.deepEqual(await pauseToasts(app), [], 'cold reopen showed a source-sync warning')

  console.log('PASS non-empty bullet Backspace merge: owner, semantic/list proof, exact source, save, and cold reopen')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
