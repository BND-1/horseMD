import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-transaction-first-authority-large-${process.pid}`
const file = join(root, 'authority-large.md')
const port = Number(process.env.CDP_PORT || 10192)

const paragraphs = Array.from({ length: 1000 }, (_, index) =>
  `长文档普通段落${index} ` +
  '这是一段只包含普通文字的保真验证内容用于跨过分块阈值并检查事务源码映射'.repeat(4) +
  ` 尾部标记${index}`
)
const sourceLf = ['# Transaction Authority Large Document', '', ...paragraphs.flatMap((text) => [text, ''])].join('\n')
const source = '\uFEFF' + sourceLf.replace(/\n/g, '\r\n')
assert.ok(source.length > 120000, `fixture did not cross long-document threshold: ${source.length}`)

const firstOriginal = paragraphs[5]
const middleOriginal = paragraphs[500]
const lastOriginal = paragraphs[995]
const firstEdited = `${firstOriginal}X`
const middleEdited = middleOriginal.slice(0, -1)
const lastEdited = `${lastOriginal.slice(0, -2)}ZZ`

let expected = source
expected = expected.replace(firstOriginal, firstEdited)
expected = expected.replace(middleOriginal, middleEdited)
expected = expected.replace(lastOriginal, lastEdited)

async function waitFor(check, message, attempts = 160) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function selectTextTail(evaluate, text, tailChars = 0) {
  const selected = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const paragraph = [...(editor?.querySelectorAll('p') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!editor || !paragraph) return false
    paragraph.scrollIntoView({ block: 'center' })

    const textNodes = []
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) textNodes.push(walker.currentNode)
    const total = textNodes.reduce((sum, node) => sum + node.nodeValue.length, 0)
    const requestedTailChars = ${JSON.stringify(tailChars)}
    if (!textNodes.length || requestedTailChars < 0 || requestedTailChars > total) return false

    const locate = (offset) => {
      let remaining = offset
      for (const node of textNodes) {
        if (remaining <= node.nodeValue.length) return { node, offset: remaining }
        remaining -= node.nodeValue.length
      }
      const node = textNodes[textNodes.length - 1]
      return { node, offset: node.nodeValue.length }
    }
    const start = locate(total - requestedTailChars)
    const end = locate(total)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(selected, true, `missing long-document paragraph: ${text.slice(0, 40)}`)
  await sleep(40)
}

const trace = (evaluate) => evaluate(`window.__hmTransactionFirstTrace || []`)
const integrityFailures = (evaluate) => evaluate(`(() => {
  const failures = (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false)
  return failures.map((entry) => {
    const candidate = String(entry.candidate || '')
    const canonical = String(entry.canonical || '')
    let firstDiff = -1
    const shared = Math.min(candidate.length, canonical.length)
    for (let index = 0; index < shared; index += 1) {
      if (candidate[index] !== canonical[index]) { firstDiff = index; break }
    }
    if (firstDiff < 0 && candidate.length !== canonical.length) firstDiff = shared
    const start = Math.max(0, firstDiff - 40)
    const end = firstDiff < 0 ? 80 : firstDiff + 80
    return {
      semanticOk: entry.semanticOk,
      transitionOk: entry.transitionOk,
      committedCheckpointOk: entry.committedCheckpointOk,
      checkpointTrusted: entry.checkpointTrusted,
      listSlotsMatch: entry.listSlotsMatch,
      listTransitionOk: entry.listTransitionOk,
      localizedListProofOk: entry.localizedListProofOk,
      validationSite: entry.validationSite,
      preservationReason: entry.preservationReason,
      firstDiff,
      candidateLength: candidate.length,
      canonicalLength: canonical.length,
      candidateSlice: candidate.slice(start, end),
      canonicalSlice: canonical.slice(start, end)
    }
  })
})()`)
const pauseToasts = (evaluate) => evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused|rich text.*source/i.test(text))
`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function waitForOwned(evaluate, label) {
  return waitFor(async () => {
    const items = await trace(evaluate)
    return items.find((entry) =>
      entry.phase === 'reconcile' &&
      entry.mode === 'authoritative' &&
      entry.transactionFamily === 'plain-paragraph-inline-replace' &&
      entry.publicationOwner === 'transaction' &&
      entry.authorityDecision === 'authority-owned'
    ) || null
  }, `${label} did not publish transaction-owned bytes in long document`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source, 'utf8')

  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor && editor.textContent.includes(${JSON.stringify(lastOriginal.slice(-20))})
      })()`),
      'large authority fixture did not finish loading',
      400
    )

    await evaluate(`(() => {
      window.__hmTransactionSourcePrimary = false
      window.__hmTransactionSourceShadow = false
      window.__hmTransactionFirstAuthority = true
      window.__hmTransactionFirstTrace = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    const timings = []

    await selectTextTail(evaluate, firstOriginal)
    let started = Date.now()
    await typeTextLikeUser(send, 'X', { delayMs: 30 })
    const firstTrace = await waitForOwned(evaluate, 'first-chunk insertion')
    timings.push({ op: 'insert-first', ms: Date.now() - started })
    assert.ok(firstTrace.sourceMapEntries >= 900, `large source map unexpectedly sparse: ${firstTrace.sourceMapEntries}`)

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await selectTextTail(evaluate, middleOriginal)
    started = Date.now()
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 30 })
    const middleTrace = await waitForOwned(evaluate, 'middle deletion')
    timings.push({ op: 'delete-middle', ms: Date.now() - started })
    assert.ok(middleTrace.sourceMapEntries >= 900)

    await evaluate(`window.__hmTransactionFirstTrace = []`)
    await selectTextTail(evaluate, lastOriginal, 2)
    started = Date.now()
    await typeTextLikeUser(send, 'ZZ', { delayMs: 30 })
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return [...(editor?.querySelectorAll('p') || [])]
          .some((node) => node.textContent === ${JSON.stringify(lastEdited)})
      })()`),
      'tail rapid replacement did not reach its final DOM text'
    )
    await waitForOwned(evaluate, 'tail rapid replacement')
    // On a small document both InsertText dispatches often land before the
    // deferred markdownUpdated callback and appear as chainLength=2. On a large
    // document the first mapping can settle before the second character arrives,
    // producing two valid chainLength=1 reconciles instead. Callback coalescing
    // is timing, not ownership: every reconcile in this replacement window must
    // be authoritative transaction publication, and final bytes are asserted
    // below after the callback queue settles.
    await sleep(350)
    const lastReconciles = (await trace(evaluate)).filter((entry) => entry.phase === 'reconcile')
    assert.ok(lastReconciles.length >= 1, 'tail replacement produced no reconcile trace')
    assert.ok(
      lastReconciles.every((entry) =>
        entry.publicationOwner === 'transaction' &&
        entry.authorityDecision === 'authority-owned' &&
        entry.transactionFamily === 'plain-paragraph-inline-replace'),
      `tail replacement fell back during long-document authority: ${JSON.stringify(lastReconciles)}`
    )
    timings.push({ op: 'replace-tail', ms: Date.now() - started })

    const failures = await integrityFailures(evaluate)
    if (failures.length) {
      console.error('authority-large integrityFailures:', JSON.stringify(failures, null, 2))
      const semanticDiffs = await evaluate(`window.__hmSourceIntegrityDiffTrace || []`)
      console.error('authority-large semanticDiffs:', JSON.stringify(semanticDiffs, null, 2))
    }
    assert.equal(failures.length, 0, 'long authority run had a first-divergence integrity failure')
    assert.equal((await pauseToasts(evaluate)).length, 0, 'long authority run showed a source-sync warning')

    assert.equal(await toggleSource(evaluate), true, 'could not switch large authority document to source mode')
    const actualSource = await waitFor(() => visibleSource(evaluate), 'large authority source textarea did not appear')
    assert.equal(
      actualSource,
      expected.replace(/\r\n?/g, '\n'),
      'long authority source textarea changed bytes outside the three owned edits'
    )
    assert.equal(await toggleSource(evaluate), true, 'could not return large authority document to rich mode')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'large authority save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'large authority save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'large authority save normalized BOM/CRLF or unrelated source bytes')

    const slowest = Math.max(...timings.map((entry) => entry.ms))
    assert.ok(slowest < 10000, `prepared long-document SourceRangeMap remained too slow: ${JSON.stringify(timings)}`)
    console.log(`PASS transaction-first authority large document: 1000 paragraphs, BOM/CRLF, three owned edits; timings=${JSON.stringify(timings)}`)
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
