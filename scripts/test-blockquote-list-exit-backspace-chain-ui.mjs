import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-blockquote-list-exit-backspace-${process.pid}`
const port = Number(process.env.CDP_PORT || 23840 + (process.pid % 30))
const packagedAppPath = process.env.HORSEMD_APP_PATH || ''
const warningPattern = /检测到富文本与源码不一致|源码.*不一致|保存已暂停|无法安全映射|原文件未被覆盖|Save paused/i
const fixture = '\uFEFF' + [
  '# list exit backspace chain',
  '',
  '1. top-one',
  '   1. nested-alpha',
  '   2. nested-beta',
  '2. top-two',
  '',
  '- bullet-alpha',
  '- bullet-beta',
  '',
  '> intro',
  '>',
  '> second',
  '>',
  '> 1. quote-one',
  '> 2. quote-two',
  '',
  'after',
  ''
].join('\r\n')

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
  window.__hmListSubtreeTransactionTrace = []
  window.__hmListItemTransactionTrace = []
  window.__hmListNestedFirstOrderedParentJoinTransactionTrace = []
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
    inheritedBlockquoteTransientPaths: entry.inheritedBlockquoteTransientPaths || [],
    activeBlockquoteTransientPaths: entry.activeBlockquoteTransientPaths || [],
    parsed: entry.ok === false ? entry.parsed : undefined,
    expected: entry.ok === false ? entry.expected : undefined,
    candidate: entry.ok === false ? entry.candidate : undefined,
    canonical: entry.ok === false ? entry.canonical : undefined
  })),
  coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-120),
  owner: (window.__hmBlockquoteTransactionTrace || []).slice(-120),
  listSubtree: (window.__hmListSubtreeTransactionTrace || []).slice(-120),
  listItem: (window.__hmListItemTransactionTrace || []).slice(-120),
  orderedParentJoin: (window.__hmListNestedFirstOrderedParentJoinTransactionTrace || []).slice(-120),
  journal: (window.__hmSourceSyncTransactionJournalTrace || []).slice(-160),
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

const focusParagraphText = async (app, selector, text, offset = 'end') => {
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
    return { ok: true, position, text: p.textContent || '' }
  })()`)
  assert.equal(result.ok, true, `could not focus ${text}: ${JSON.stringify(result)}`)
  await sleep(80)
}

const openApp = async ({ file, profile, reopen = false }) => {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: reopen ? port + 1 : port,
    appArgs: [file, '--horsemd-input-trace'],
    executable: packagedAppPath || undefined,
    entrypoint: packagedAppPath ? null : undefined
  })
  try {
    await waitFor(() => app.evaluate(`(() => {
      const editor = ${visibleEditor()}
      return Boolean(editor && (editor.textContent || '').includes('quote-two') && (editor.textContent || '').includes('after'))
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
const file = join(root, 'replay.md')
await writeFile(file, fixture, 'utf8')
let app = await openApp({ file, profile: 'edit' })
let finalSource = null
try {
  await clearDiagnostics(app)
  await focusParagraphText(app, 'blockquote ol li p', 'quote-two', 'end')
  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 25 })
  await sleep(850)
  let first = await snapshot(app)
  assertClean(first, 'first Enter empty quote-list sibling')

  await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 25 })
  await sleep(1000)
  const exited = await snapshot(app)
  console.log('AFTER_QUOTE_LIST_EXIT:', JSON.stringify(exited))
  assertClean(exited, 'second Enter quote-list exit')
  const publication = exited.preserve.find((entry) =>
    entry.reason === 'trailing-empty-blockquote-paragraph-after-list-exit' &&
    entry.integrityProof?.kind === 'transaction-blockquote-list-exit-pending-proof'
  )
  assert.ok(publication, `list exit did not use focused blockquote owner: ${JSON.stringify(exited.preserve)}`)
  assert.deepEqual(publication.integrityProof.nodePath, [3])
  assert.equal(publication.integrityProof.listType, 'ordered_list')
  assert.equal(exited.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'blockquote-paragraph-exit' &&
    entry.reason === 'trailing-empty-blockquote-paragraph-after-list-exit'
  ), true, `list exit bypassed Coordinator: ${JSON.stringify(exited.coordinator)}`)

  // Reproduce the user's later "all on Backspace" phase from a CLEAN source
  // baseline. These edits are intentionally elsewhere in the document: if the
  // quote transient is carried correctly they must not resurrect the removed
  // `> 3. <br />` row or trigger integrity warnings.
  await focusParagraphText(app, 'ol ol li p', 'nested-alpha', 'start')
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 35 })
  await sleep(900)
  const afterNestedBackspace = await snapshot(app)
  console.log('AFTER_NESTED_BACKSPACE:', JSON.stringify(afterNestedBackspace))
  assertClean(afterNestedBackspace, 'nested ordered Backspace after quote-list exit')
  const orderedJoinPublication = afterNestedBackspace.preserve.find((entry) =>
    entry.reason === 'list-nested-first-ordered-parent-joined' &&
    entry.integrityProof?.kind === 'transaction-list-nested-first-ordered-parent-join-proof'
  )
  assert.ok(
    orderedJoinPublication,
    `nested ordered Backspace did not use focused owner: ${JSON.stringify(afterNestedBackspace)}`
  )
  assert.equal(orderedJoinPublication.integrityProof.chainLength, 2)
  assert.equal(orderedJoinPublication.integrityProof.firstStep.sliceSize, 1)
  assert.equal(orderedJoinPublication.integrityProof.secondStep.sliceSize, 2)
  assert.equal(afterNestedBackspace.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'list-nested-first-ordered-parent-join' &&
    entry.reason === 'list-nested-first-ordered-parent-joined'
  ), true, `nested ordered Backspace bypassed Coordinator: ${JSON.stringify(afterNestedBackspace.coordinator)}`)

  await focusParagraphText(app, 'ul li p', 'bullet-beta', 'start')
  await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 35 })
  await sleep(900)
  const afterBulletBackspace = await snapshot(app)
  console.log('AFTER_BULLET_BACKSPACE:', JSON.stringify(afterBulletBackspace))
  assertClean(afterBulletBackspace, 'bullet Backspace after quote-list exit')
  const bulletJoinPublication = afterBulletBackspace.preserve.find((entry) =>
    entry.reason === 'transaction-list-subtree' &&
    entry.integrityProof?.kind === 'transaction-list-subtree-proof' &&
    entry.integrityProof?.mapperReason === 'diverged-sibling-list-item-paragraph-join'
  )
  assert.ok(
    bulletJoinPublication,
    `bullet Backspace did not use proof-gated list-subtree mapping: ${JSON.stringify(afterBulletBackspace)}`
  )
  assert.equal(
    bulletJoinPublication.integrityProof.siblingParagraphJoin?.kind,
    'transaction-list-sibling-item-paragraph-join-proof'
  )
  assert.equal(afterBulletBackspace.coordinator.some((entry) =>
    entry.phase === 'published' &&
    entry.owner === 'transaction' &&
    entry.family === 'list-subtree-replace' &&
    entry.reason === 'transaction-list-subtree'
  ), true, `bullet Backspace bypassed Coordinator: ${JSON.stringify(afterBulletBackspace.coordinator)}`)

  assert.equal(await toggleSource(app), true, 'could not inspect source')
  finalSource = await waitFor(() => visibleSource(app), 'source did not open')
  assert.equal(finalSource.includes('> 3. <br />'), false, 'removed empty quote-list row leaked back into source')
  assert.equal(finalSource.includes('> 1. quote-one'), true)
  assert.equal(finalSource.includes('> 2. quote-two'), true)
  assert.equal(await toggleSource(app), true, 'could not return to rich mode')
  await sleep(300)

  await save(app)
  const disk = await readFile(file, 'utf8')
  assert.equal(disk.replace(/\r\n/g, '\n'), finalSource, 'saved bytes diverged from committed source view')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  app = null
}

app = await openApp({ file, profile: 'reopen', reopen: true })
try {
  const reopened = await snapshot(app)
  assertClean(reopened, 'cold reopen')
  assert.equal(await toggleSource(app), true, 'could not inspect cold source')
  const coldSource = await waitFor(() => visibleSource(app), 'cold source did not open')
  assert.equal(coldSource, finalSource, 'cold reopen source changed')
  assert.equal(coldSource.includes('> 3. <br />'), false, 'cold reopen resurrected empty quote-list row')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
}

await rm(root, { recursive: true, force: true })
console.log('PASS blockquote list-exit/backspace chain UI: focused quote-list exit fixes the first failure and later nested/bullet Backspace edits remain warning-free through source, save and cold reopen')
