import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rs68-rapid-parent-lift-${process.pid}`
const file = join(root, 'rs-68.md')
const port = Number(process.env.CDP_PORT || 10968)
const keyDelay = Number(process.env.RS68_KEY_DELAY ?? 18)
const fixture = [
  '# RS68',
  '',
  '- 可就是被科技部',
  '- 老板老板娘',
  '  - s 入了你看你了',
  '',
  '- u高科技',
  '',
  '1. 啊额法',
  '   1. 微风',
  '',
  '-   1. 二哥你来拿如果',
  '  - \u200B     就了解了呢',
  '  * 如果可能老顾客',
  '',
  '后文',
  ''
].join('\n')
const expected = fixture.replace('1. 啊额法\n   1. 微风', '- \n   1. 微风')
const warningPattern = /源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

async function waitFor(check, message, attempts = 160) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const shape = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const childP = [...(editor?.querySelectorAll('p') || [])]
    .find((node) => node.textContent === '微风')
  const childLi = childP?.closest('li')
  let parentLi = null
  let cursor = childLi?.parentElement || null
  while (cursor && cursor !== editor) {
    if (cursor.tagName === 'LI') {
      parentLi = cursor
      break
    }
    cursor = cursor.parentElement
  }
  const parentP = parentLi
    ? [...parentLi.querySelectorAll('p')].find((node) => node.closest('li') === parentLi)
    : null
  const parentList = parentLi?.parentElement?.closest('ul,ol') || null
  const childList = childLi?.parentElement?.closest('ul,ol') || null
  return {
    parentExists: !!parentLi,
    parentText: parentP?.textContent ?? '',
    parentListTag: parentList?.tagName ?? null,
    childText: childP?.textContent ?? null,
    childListTag: childList?.tagName ?? null,
    childNested: !!(parentLi && childLi && parentLi.contains(childLi)),
    preserve: (window.__hmPreserveLog || []).slice(-20).map(({ reason, preserved, source, previous, next, markdown, integrityProof }) => ({
      reason,
      preserved,
      integrityProof: integrityProof || null,
      source: String(source || ''),
      previous: String(previous || ''),
      next: String(next || ''),
      markdown: String(markdown || '')
    })),
    coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-20),
    integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map((entry) => ({
      ok: entry.ok,
      semanticOk: entry.semanticOk,
      transitionOk: entry.transitionOk,
      checkpointTrusted: entry.checkpointTrusted,
      listSlotsMatch: entry.listSlotsMatch,
      listTransitionOk: entry.listTransitionOk,
      localizedListProofOk: entry.localizedListProofOk,
      localizedListProofTrace: entry.localizedListProofTrace || null,
      preservationProof: entry.preservationProof || null,
      validationSite: entry.validationSite || '',
      preservationReason: entry.preservationReason,
      candidate: String(entry.candidate || '').slice(-900),
      canonical: String(entry.canonical || '').slice(-900)
    })),
    toasts: [...document.querySelectorAll('[class*="toast"]')]
      .filter((node) => node.offsetParent)
      .map((node) => node.textContent || '')
  }
})()`)

const placeCaretAfterParent = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const p = [...(editor?.querySelectorAll('p') || [])].find((node) => node.textContent === '啊额法')
  if (!p) return false
  const li = p.closest('li')
  if (!li || ![...li.querySelectorAll('ol p')].some((node) => node.textContent === '微风')) return false
  const text = [...p.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.includes('啊额法'))
  if (!text) return false
  const range = document.createRange()
  range.setStart(text, text.nodeValue.length)
  range.collapse(true)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  editor.focus()
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('啊额法') && (node.textContent || '').includes('微风')))`),
    'RS-68 fixture did not mount'
  )
  await sleep(650)
  return app
}

async function save(app) {
  await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
}

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
    window.__hmSourceSyncCoordinatorTrace = []
  })()`)

  assert.equal(await placeCaretAfterParent(app), true, 'could not place caret after RS-68 parent body')

  // Deliberately faster than the deferred markdownUpdated cadence. Three
  // Backspaces remove 啊/额/法; the fourth lifts the now-empty ordered parent.
  // There is NO settle between keys, so the source mapper must own the combined
  // old-canonical -> final-canonical transaction rather than depending on an
  // intermediate RS-67 checkpoint.
  for (let i = 0; i < 4; i += 1) {
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: keyDelay })
  }
  await sleep(1100)

  const after = await shape(app)
  console.log('RS68_AFTER_RAPID_BACKSPACE:', JSON.stringify(after))
  assert.equal(after.parentExists, true, `RS-68 lost parent item: ${JSON.stringify(after)}`)
  assert.equal(after.parentText, '', `RS-68 parent body not empty: ${JSON.stringify(after)}`)
  assert.equal(after.parentListTag, 'UL', `RS-68 parent did not lift into bullet list: ${JSON.stringify(after)}`)
  assert.equal(after.childText, '微风', `RS-68 changed nested child text: ${JSON.stringify(after)}`)
  assert.equal(after.childListTag, 'OL', `RS-68 child is no longer ordered: ${JSON.stringify(after)}`)
  assert.equal(after.childNested, true, `RS-68 child escaped the parent item: ${JSON.stringify(after)}`)
  assert.equal(after.preserve.some((entry) => entry.reason === 'rapid-nested-ordered-parent-backspace-lift' && entry.preserved === true), true,
    `RS-68 combined proof did not own the rapid batch: ${JSON.stringify(after.preserve)}`)
  assert.equal(after.integrity.some((entry) => entry.ok === false), false, `RS-68 integrity failure: ${JSON.stringify(after.integrity)}`)
  assert.equal(after.integrity.some((entry) =>
    entry.preservationReason === 'rapid-nested-ordered-parent-backspace-lift' &&
    entry.ok === true && entry.semanticOk === true &&
    (entry.listSlotsMatch === true || entry.localizedListProofOk === true)
  ), true, `RS-68 candidate was not fully equivalent: ${JSON.stringify(after.integrity)}`)
  if (keyDelay >= 70) {
    assert.equal(after.coordinator.some((entry) =>
      entry.phase === 'published' &&
      entry.boundary === 'forced-flush' &&
      entry.owner === 'legacy' &&
      entry.family === 'legacy-preservation' &&
      entry.reason === 'rapid-nested-ordered-parent-backspace-lift'
    ), true, `RS-68 70ms forced flush bypassed SourceSyncCoordinator publication: ${JSON.stringify(after.coordinator)}`)
  }
  assert.equal(after.toasts.some((text) => warningPattern.test(text)), false, `RS-68 warning toast: ${JSON.stringify(after.toasts)}`)

  assert.equal(await toggleSource(app), true, 'could not open RS-68 source mode')
  const source = await waitFor(() => visibleSource(app), 'RS-68 source textarea missing')
  console.log('RS68_SOURCE:', JSON.stringify(source))
  assert.equal(source, expected, `RS-68 source mismatch: ${JSON.stringify(source)}`)
  assert.equal(source.includes('- \n\n   1. 微风'), false, 'RS-68 retained the parse-breaking blank line between empty parent and child')
  assert.equal(source.includes('<br'), false, 'RS-68 leaked editor placeholder into authored source')

  assert.equal(await toggleSource(app), true, 'could not return RS-68 to rich mode')
  await save(app)
  assert.equal(await readFile(file, 'utf8'), expected, 'RS-68 disk bytes differ from source')

  await stopBuiltElectron(app, { removeProfile: true })
  app = null
  app = await launchBuiltElectron({
    profileDir: join(root, 'reopen'),
    port: port + 1,
    appArgs: [file, '--horsemd-input-trace']
  })
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent && (node.textContent || '').includes('微风') && (node.textContent || '').includes('后文')))`),
    'RS-68 reopened fixture did not mount'
  )
  await sleep(650)
  const reopened = await shape(app)
  console.log('RS68_REOPENED:', JSON.stringify(reopened))
  assert.equal(reopened.parentExists, true, 'RS-68 reopen lost empty bullet parent')
  assert.equal(reopened.parentListTag, 'UL', `RS-68 reopen changed parent list type: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.childText, '微风', `RS-68 reopen changed child text: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.childListTag, 'OL', `RS-68 reopen changed child list type: ${JSON.stringify(reopened)}`)
  assert.equal(reopened.childNested, true, `RS-68 reopen flattened child: ${JSON.stringify(reopened)}`)
  assert.equal(await toggleSource(app), true, 'could not inspect reopened RS-68 source')
  assert.equal(await waitFor(() => visibleSource(app), 'reopened RS-68 source missing'), expected)

  console.log(`PASS RS-68 rapid nested parent Backspace lift (${keyDelay}ms): coalesced batch, integrity, source, save, and reopen stable`)
} finally {
  if (app) await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
