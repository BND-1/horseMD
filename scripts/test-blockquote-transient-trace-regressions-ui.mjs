import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-blockquote-transient-trace-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 23920 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i

const waitFor = async (check, message, attempts = 180) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}
const visibleEditor = () => `([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent))`
const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)
const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)
const clearDiagnostics = (app) => app.evaluate(`(() => {
  window.__hmPreserveLog = []
  window.__hmSourceIntegrityTrace = []
  window.__hmSourceSyncCoordinatorTrace = []
  window.__hmSourceSyncTransactionJournalTrace = []
  window.__hmBlockquoteTransactionTrace = []
  window.__hmListEmptyItemTailTransactionTrace = []
  window.__hmFlushTrace = []
})()`)
const snapshot = (app) => app.evaluate(`(() => ({
  preserve: (window.__hmPreserveLog || []).slice(-120).map(({ source, previous, next, markdown, ...entry }) => entry),
  integrity: (window.__hmSourceIntegrityTrace || []).slice(-120).map((entry) => ({
    ok: entry.ok,
    semanticOk: entry.semanticOk,
    listSlotsMatch: entry.listSlotsMatch,
    preservationReason: entry.preservationReason,
    validationSite: entry.validationSite,
    parsed: entry.ok === false ? entry.parsed : undefined,
    expected: entry.ok === false ? entry.expected : undefined
  })),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-120),
  journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-160),
  blockquote: (window.__hmBlockquoteTransactionTrace || []).slice(-120),
  listTail: (window.__hmListEmptyItemTailTransactionTrace || []).slice(-120),
  toasts: [...document.querySelectorAll('[class*="toast"]')]
    .filter((node) => node.offsetParent)
    .map((node) => node.textContent || '')
}))()`)
const assertClean = (state, label) => {
  assert.equal(state.integrity.some((entry) => entry.ok === false), false,
    `${label} integrity failed: ${JSON.stringify(state.integrity)}`)
  assert.equal(state.toasts.some((text) => warningPattern.test(text)), false,
    `${label} warned: ${JSON.stringify(state.toasts)}`)
}
const focusText = async (app, selector, text, offset = 'end') => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const p = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
      .find((node) => (node.textContent || '').trim() === ${JSON.stringify(text)})
    if (!p) return { ok: false, reason: 'paragraph-not-found' }
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    const nodes = []
    let node
    while ((node = walker.nextNode())) nodes.push(node)
    const target = ${JSON.stringify(offset)} === 'start' ? nodes[0] : nodes.at(-1)
    if (!target) return { ok: false, reason: 'text-node-not-found' }
    const position = ${JSON.stringify(offset)} === 'start' ? 0 : (target.nodeValue?.length || 0)
    const range = document.createRange()
    range.setStart(target, position)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true }
  })()`)
  assert.equal(result.ok, true, `could not focus ${text}: ${JSON.stringify(result)}`)
  await sleep(70)
}
const focusEmptyQuoteParagraph = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const paragraphs = [...(editor?.querySelectorAll('blockquote p') || [])]
    const paragraph = paragraphs.find((node) => !(node.textContent || '').trim())
    if (!paragraph) return { ok: false, reason: 'empty-quote-paragraph-not-found' }
    const rect = paragraph.getBoundingClientRect()
    return {
      ok: true,
      point: { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
    }
  })()`)
  assert.equal(result.ok, true, `could not focus empty quote paragraph: ${JSON.stringify(result)}`)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...result.point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...result.point, button: 'left', clickCount: 1 })
  await sleep(80)
}

const focusLastQuoteListItem = async (app) => {
  const result = await app.evaluate(`(() => {
    const editor = ${visibleEditor()}
    const list = editor?.querySelector('blockquote ol')
    const items = [...(list?.querySelectorAll('li') || [])]
    const paragraph = items.at(-1)?.querySelector('p')
    if (!paragraph || (paragraph.textContent || '').trim()) {
      return {
        ok: false,
        reason: 'empty-tail-not-found',
        itemCount: items.length,
        texts: items.map((item) => item.querySelector('p')?.textContent || '')
      }
    }
    const rect = paragraph.getBoundingClientRect()
    return {
      ok: true,
      text: paragraph.textContent || '',
      itemCount: items.length,
      point: { x: rect.left + 10, y: rect.top + Math.max(8, Math.min(16, rect.height / 2)) }
    }
  })()`)
  assert.equal(result.ok, true, `could not focus quote-list tail: ${JSON.stringify(result)}`)
  assert.equal(result.text, '')
  assert.equal(result.itemCount, 3)
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...result.point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...result.point, button: 'left', clickCount: 1 })
  await sleep(80)
}
const openApp = async ({ file, profile, port, marker }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      return Boolean(editor && (editor.textContent || '').includes(${JSON.stringify(marker)}))
    })()`), `${profile} editor did not mount`)
    await sleep(450)
    return app
  } catch (error) {
    await stopBuiltElectron(app, { removeProfile: true })
    throw error
  }
}
const save = async (app) => {
  await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save button missing')
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

// Regression 1: the user's real cadence produced two ReplaceSteps in one pending journal:
// a plain trailing-space insertion immediately followed by Enter at quote paragraph end.
{
  const file = join(root, 'suffix-enter.md')
  const fixture = '\uFEFF# suffix enter\r\n\r\n> quote-alpha\r\n\r\nafter\r\n'
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: 'suffix-enter', port: basePort, marker: 'quote-alpha' })
  let finalSource = null
  try {
    await clearDiagnostics(app)
    await focusText(app, 'blockquote p', 'quote-alpha', 'end')
    await typeTextLikeUser(app.send, ' ', { delayMs: 1 })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 1 })
    await sleep(1000)
    const state = await snapshot(app)
    assertClean(state, 'quote suffix+Enter')
    const publication = state.preserve.find((entry) =>
      entry.reason === 'trailing-empty-blockquote-paragraph-created' &&
      entry.integrityProof?.kind === 'transaction-blockquote-exit-pending-proof'
    )
    assert.ok(publication, `suffix+Enter bypassed pending owner: ${JSON.stringify(state)}`)
    const proof = publication.integrityProof
    const coalesced = proof.insertedSuffix === ' ' &&
      proof.preSplitTextStepCount === 1 && proof.chainLength === 2 && proof.sourceUnchanged === false
    const staged = proof.insertedSuffix === '' &&
      proof.preSplitTextStepCount === 0 && proof.chainLength === 1 &&
      proof.sourceUnchanged === true && proof.baselineSingleTrailingSpace === true
    assert.equal(coalesced || staged, true,
      `suffix+Enter used an unproven timing shape: ${JSON.stringify(proof)}`)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' &&
      entry.owner === 'transaction' &&
      entry.family === 'blockquote-paragraph-exit' &&
      entry.reason === 'trailing-empty-blockquote-paragraph-created'
    ), true, `suffix+Enter bypassed Coordinator: ${JSON.stringify(state.coordinator)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect suffix+Enter source')
    finalSource = await waitFor(() => visibleSource(app), 'suffix+Enter source did not open')
    assert.equal(finalSource.includes('> quote-alpha '), true, `authored trailing space byte was not preserved: ${JSON.stringify(finalSource)}`)
    assert.equal(finalSource.includes('&#x20;'), false, 'rich trailing space was unnecessarily rewritten as an entity')
    assert.equal(finalSource.includes('> <br />'), false, 'transient empty quote paragraph leaked into source')
    assert.equal(await toggleSource(app), true, 'could not return suffix+Enter to rich mode')
    await sleep(250)
    await save(app)
    const disk = await readFile(file, 'utf8')
    assert.equal(disk.replace(/\r\n/g, '\n'), finalSource, 'suffix+Enter saved bytes diverged from source view')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  app = await openApp({ file, profile: 'suffix-enter-cold', port: basePort + 1, marker: 'quote-alpha' })
  try {
    assert.equal(await toggleSource(app), true, 'could not inspect cold suffix+Enter source')
    const coldSource = await waitFor(() => visibleSource(app), 'cold suffix+Enter source did not open')
    assert.equal(coldSource, finalSource, 'suffix+Enter source changed after cold reopen')
    assert.equal(coldSource.includes('> quote-alpha '), true, 'cold reopen lost authored trailing space byte')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Regression 1b: multiple plain-text bytes can still be pending when Enter arrives.
// This is the deterministic physical counterpart of the user's IME replacement trace:
// the owner must map the uncommitted text journal before proving the empty quote tail.
{
  const file = join(root, 'rapid-text-enter.md')
  const fixture = '\uFEFF# rapid text enter\r\n\r\n> quote-ime\r\n\r\nafter\r\n'
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: 'rapid-text-enter', port: basePort + 5, marker: 'quote-ime' })
  let finalSource = null
  try {
    await clearDiagnostics(app)
    await focusText(app, 'blockquote p', 'quote-ime', 'end')
    await typeTextLikeUser(app.send, 'rapid', { delayMs: 1 })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 1 })
    await sleep(1000)
    const state = await snapshot(app)
    assertClean(state, 'quote rapid-text+Enter')
    const publication = state.preserve.find((entry) =>
      entry.reason === 'trailing-empty-blockquote-paragraph-created' &&
      entry.integrityProof?.kind === 'transaction-blockquote-exit-pending-proof' &&
      entry.integrityProof?.mappedPreSplitText === true
    )
    assert.ok(publication, `rapid text+Enter did not atomically map pending text: ${JSON.stringify(state)}`)
    assert.equal(publication.integrityProof.preSplitTextStepCount > 0, true)
    assert.equal(publication.integrityProof.textChangeMode, 'suffix')
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' &&
      entry.owner === 'transaction' &&
      entry.family === 'blockquote-paragraph-exit' &&
      entry.reason === 'trailing-empty-blockquote-paragraph-created'
    ), true, `rapid text+Enter bypassed Coordinator: ${JSON.stringify(state.coordinator)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect rapid text+Enter source')
    finalSource = await waitFor(() => visibleSource(app), 'rapid text+Enter source did not open')
    assert.equal(finalSource.includes('> quote-imerapid'), true,
      `pending rapid text was not preserved in source: ${JSON.stringify(finalSource)}`)
    assert.equal(finalSource.includes('> <br />'), false, 'rapid text+Enter leaked transient quote placeholder')
    assert.equal(await toggleSource(app), true, 'could not return rapid text+Enter to rich mode')
    await sleep(250)
    await save(app)
    const disk = await readFile(file, 'utf8')
    assert.equal(disk.replace(/\r\n/g, '\n'), finalSource,
      'rapid text+Enter saved bytes diverged from source view')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  app = await openApp({ file, profile: 'rapid-text-enter-cold', port: basePort + 6, marker: 'quote-imerapid' })
  try {
    const reopened = await snapshot(app)
    assertClean(reopened, 'rapid text+Enter cold reopen')
    assert.equal(await toggleSource(app), true, 'could not inspect cold rapid text+Enter source')
    const coldSource = await waitFor(() => visibleSource(app), 'cold rapid text+Enter source did not open')
    assert.equal(coldSource, finalSource, 'rapid text+Enter source changed after cold reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Regression 1c: an authored empty quote row has no text source-map anchor.
// Bound it by neighbouring stable textblocks, fill that exact physical row, then Enter.
{
  const file = join(root, 'empty-quote-fill-enter.md')
  const fixture = '\uFEFF# empty quote fill\r\n\r\n>\r\n\r\nafter\r\n'
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: 'empty-quote-fill-enter', port: basePort + 7, marker: 'empty quote fill' })
  let finalSource = null
  try {
    await clearDiagnostics(app)
    await focusEmptyQuoteParagraph(app)
    await typeTextLikeUser(app.send, 'rapid', { delayMs: 1 })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 1 })
    await sleep(1000)
    const state = await snapshot(app)
    assertClean(state, 'empty quote fill+Enter')
    const publication = state.preserve.find((entry) =>
      entry.reason === 'trailing-empty-blockquote-paragraph-created' &&
      entry.integrityProof?.kind === 'transaction-blockquote-exit-pending-proof' &&
      entry.integrityProof?.emptyBaselineFill === true
    )
    assert.ok(publication, `empty quote fill+Enter bypassed focused owner: ${JSON.stringify(state)}`)
    const proof = publication.integrityProof
    assert.equal(proof.preSplitTextStepCount > 0, true)
    assert.equal(proof.emptyRowProof?.previousAnchorPath?.length > 0, true,
      `empty quote fill lacked previous stable anchor: ${JSON.stringify(proof)}`)
    assert.equal(proof.emptyRowProof?.nextAnchorPath?.length > 0, true,
      `empty quote fill lacked next stable anchor: ${JSON.stringify(proof)}`)
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' &&
      entry.owner === 'transaction' &&
      entry.family === 'blockquote-paragraph-exit' &&
      entry.reason === 'trailing-empty-blockquote-paragraph-created'
    ), true, `empty quote fill+Enter bypassed Coordinator: ${JSON.stringify(state.coordinator)}`)
    assert.equal(await toggleSource(app), true, 'could not inspect empty quote fill source')
    finalSource = await waitFor(() => visibleSource(app), 'empty quote fill source did not open')
    assert.equal(finalSource.includes('>rapid'), true,
      `empty authored quote row was not filled in source: ${JSON.stringify(finalSource)}`)
    assert.equal(finalSource.includes('> <br />'), false, 'empty quote fill leaked transient quote placeholder')
    assert.equal(await toggleSource(app), true, 'could not return empty quote fill to rich mode')
    await sleep(250)
    await save(app)
    const disk = await readFile(file, 'utf8')
    assert.equal(disk.replace(/\r\n/g, '\n'), finalSource,
      'empty quote fill saved bytes diverged from source view')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  app = await openApp({ file, profile: 'empty-quote-fill-enter-cold', port: basePort + 8, marker: 'rapid' })
  try {
    const reopened = await snapshot(app)
    assertClean(reopened, 'empty quote fill cold reopen')
    assert.equal(await toggleSource(app), true, 'could not inspect cold empty quote fill source')
    const coldSource = await waitFor(() => visibleSource(app), 'cold empty quote fill source did not open')
    assert.equal(coldSource, finalSource, 'empty quote fill source changed after cold reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Regression 2: Backspace on the last empty ordered item inside a top-level blockquote.
{
  const file = join(root, 'quote-list-tail.md')
  const fixture = '\uFEFF' + [
    '# quote tail',
    '',
    '> intro',
    '>',
    '> 1. alpha',
    '> 2. beta',
    '> 3. <br />',
    '',
    'after',
    ''
  ].join('\r\n')
  await writeFile(file, fixture, 'utf8')
  let app = await openApp({ file, profile: 'quote-tail-edit', port: basePort + 2, marker: 'beta' })
  let finalSource = null
  try {
    await clearDiagnostics(app)
    await focusLastQuoteListItem(app)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 25 })
    await sleep(1000)
    const state = await snapshot(app)
    assertClean(state, 'quote-list empty-tail Backspace')
    const publication = state.preserve.find((entry) =>
      entry.reason === 'list-empty-item-tail-removed' &&
      entry.integrityProof?.kind === 'transaction-list-empty-item-tail-remove-proof' &&
      entry.integrityProof?.containerType === 'blockquote'
    )
    assert.ok(publication, `quote-list tail Backspace bypassed tail owner: ${JSON.stringify(state)}`)
    assert.deepEqual(publication.integrityProof.listPath, [1, 1])
    assert.deepEqual(publication.integrityProof.removedPath, [1, 1, 2])
    assert.deepEqual(publication.integrityProof.transientEmptyParagraphPath, [1, 1, 1, 1])
    assert.equal(state.coordinator.some((entry) =>
      entry.phase === 'published' &&
      entry.owner === 'transaction' &&
      entry.family === 'list-empty-item-tail-remove' &&
      entry.reason === 'list-empty-item-tail-removed'
    ), true, `quote-list tail Backspace bypassed Coordinator: ${JSON.stringify(state.coordinator)}`)

    assert.equal(await toggleSource(app), true, 'could not inspect quote-tail source')
    finalSource = await waitFor(() => visibleSource(app), 'quote-tail source did not open')
    assert.equal(finalSource.includes('> 3. <br />'), false, 'removed quote-list tail row leaked into source')
    assert.equal(finalSource.includes('> 1. alpha'), true)
    assert.equal(finalSource.includes('> 2. beta'), true)
    assert.equal(await toggleSource(app), true, 'could not return quote-tail to rich mode')
    await sleep(250)
    await save(app)
    const disk = await readFile(file, 'utf8')
    assert.equal(disk.replace(/\r\n/g, '\n'), finalSource, 'quote-tail saved bytes diverged from source view')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  app = await openApp({ file, profile: 'quote-tail-reopen', port: basePort + 4, marker: 'beta' })
  try {
    const reopened = await snapshot(app)
    assertClean(reopened, 'quote-list tail cold reopen')
    assert.equal(await toggleSource(app), true, 'could not inspect quote-tail cold source')
    const coldSource = await waitFor(() => visibleSource(app), 'quote-tail cold source did not open')
    assert.equal(coldSource, finalSource, 'quote-tail cold reopen source changed')
    assert.equal(coldSource.includes('> 3. <br />'), false, 'cold reopen resurrected quote-list empty tail')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log('PASS blockquote transient trace regressions UI: single-space+Enter, pending nonempty text+Enter, empty authored quote fill+Enter, and quote-list empty-tail Backspace remain warning-free through source/save/disk/cold reopen')
