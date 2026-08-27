// Repro: at the end of a real user file, hand-type a fenced code block
// (``` Enter content Enter ```) and verify source sync, save and reopen.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const sourceFile = process.env.FILE
const defaultFixture = [
  '# 代码块连续编辑回归',
  '',
  '-',
  '',
  '1. 啊发我发',
  '2. 气氛 分',
  ''
].join('\n')
const marker = `fence${process.pid}`
const codeEdit = `code_edit_${process.pid}`
const trailingProse = `尾部正文${process.pid}`
const precedingEdit = `前文修订${process.pid}`
const root = `/tmp/horsemd-tail-fence-${process.pid}`
const file = join(root, 'fence.md')
const port = Number(process.env.CDP_PORT || 9910)
const delay = Number(process.env.KEY_DELAY || 70)
const slashSettleMs = Number(process.env.TAIL_FENCE_SLASH_SETTLE_MS || 350)
const testExecutable = process.env.HORSEMD_TEST_EXECUTABLE || ''
const inputRuleFence = process.env.TAIL_FENCE_INPUT_RULE === '1'
const slashFence = process.env.TAIL_FENCE_SLASH === '1'
const slashQuery = process.env.TAIL_FENCE_SLASH_QUERY || '/code'
const slashBlockStyle = process.env.TAIL_FENCE_BLOCK_STYLE || 'fence'
const expectedFenceInfo = process.env.TAIL_FENCE_EXPECTED_INFO || ''
const continuousPostFenceEdit = process.env.TAIL_FENCE_CONTINUOUS === '1'
const fenceVariant = slashFence
  ? `slash-${slashQuery.replace(/^\//, '') || 'code'}`
  : inputRuleFence ? 'input-rule' : 'literal-fence'

async function waitFor(check, message, attempts = 150) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function focusEnd(evaluate, send) {
  const done = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    if (!editor) return false
    editor.focus()
    const selection = getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  if (!done) throw new Error('could not focus document end')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
  await sleep(150)
}

async function placeCodeCaretAtFirstLineEnd(evaluate, send) {
  const placed = await waitFor(() => evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const blocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
    const content = blocks.at(-1)?.querySelector('.cm-content')
    const line = content?.querySelector('.cm-line:first-child')
    if (!content || !line) return false
    // Language highlighting wraps tokens in spans, so lastChild is not
    // guaranteed to be a Text node. A collapsed range at the end of the whole
    // rendered line maps to the same CodeMirror position for plain/highlighted
    // content and survives asynchronous decoration updates.
    content.focus()
    const range = document.createRange()
    range.selectNodeContents(line)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`), 'could not place caret in the tail code block').catch(() => false)
  assert.equal(placed, true, 'could not place caret in the tail code block')
  await pressKey(send, { key: 'End', code: 'End', delayMs: 40 })
  await sleep(150)
}

async function placeTrailingParagraphCaret(evaluate) {
  const placed = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const block = editor?.lastElementChild
    if (!block || block.tagName !== 'P') return false
    const range = document.createRange()
    range.selectNodeContents(block)
    range.collapse(false)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(placed, true, 'could not place caret in the paragraph after the tail code block')
  await sleep(150)
}

async function placeCaretAfterText(evaluate, text) {
  const placed = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    const candidates = []
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue === ${JSON.stringify('气氛 分')}) candidates.push(walker.currentNode)
    }
    const node = candidates.at(-1)
    if (!node) return false
    const range = document.createRange()
    range.setStart(node, node.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  assert.equal(placed, true, `could not place caret after ${text}`)
  await sleep(150)
}

async function applyPostFenceEdits(app) {
  if (slashBlockStyle === 'math') {
    const activeMath = await app.evaluate(`(() => {
      const content = document.activeElement?.closest('.cm-content') ||
        (document.activeElement?.classList?.contains('cm-content') ? document.activeElement : null)
      const block = content?.closest('.milkdown-code-block')
      return !!content && !!block && (block.innerText || '').includes(${JSON.stringify(marker)})
    })()`)
    assert.equal(activeMath, true, 'slash math editor lost focus before the continuous edit')
    await pressKey(app.send, { key: 'End', code: 'End', delayMs: 40 })
    await sleep(150)
  } else {
    await placeCodeCaretAtFirstLineEnd(app.evaluate, app.send)
  }
  await typeTextLikeUser(app.send, codeEdit, { delayMs: delay })
  await placeTrailingParagraphCaret(app.evaluate)
  await typeTextLikeUser(app.send, trailingProse, { delayMs: delay })
  await placeCaretAfterText(app.evaluate, '气氛 分')
  await typeTextLikeUser(app.send, precedingEdit, { delayMs: delay })
  await sleep(800)
}

async function typeBacktick(send) {
  const common = {
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: '`', unmodifiedText: '`' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

async function typeSpace(send) {
  const common = {
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32
  }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: ' ', unmodifiedText: ' ' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(delay)
}

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

const toasts = (evaluate) => evaluate(`[...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent)`)

const editedBlockState = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const text = (node) => (node?.innerText || '').replace(/\u200b/g, '')
  const codeBlocks = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
  const rawCodeText = (node) => (node?.querySelector('.cm-content')?.textContent || text(node))
  const codeBlock = codeBlocks.find((node) => rawCodeText(node).includes(${JSON.stringify(marker)}))
  const precedingNode = [...(editor?.querySelectorAll('li') || [])]
    .find((node) => text(node).includes(${JSON.stringify(precedingEdit)}))
  const trailingNode = [...(editor?.children || [])]
    .find((node) => node.tagName === 'P' && text(node).includes(${JSON.stringify(trailingProse)}))
  return {
    codeBlock: codeBlock ? rawCodeText(codeBlock) : null,
    precedingListItem: precedingNode ? text(precedingNode) : null,
    trailingParagraph: trailingNode ? text(trailingNode) : null
  }
})()`)

function assertEditedBlockState(state, label) {
  assert.ok(state?.codeBlock?.includes(marker), `${label}: marker is not inside a code block`)
  assert.ok(state.codeBlock.includes(codeEdit), `${label}: edited code is not inside that code block`)
  assert.ok(state?.precedingListItem?.includes(precedingEdit), `${label}: preceding edit left its list item`)
  assert.ok(state?.trailingParagraph?.includes(trailingProse), `${label}: trailing prose is not a paragraph`)
}

function fencedBlocksContaining(source, token) {
  const lines = String(source || '').split(/\r\n|\r|\n/)
  const blocks = []
  let open = null
  for (const line of lines) {
    if (!open) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (match) open = { marker: match[1], lines: [line] }
      continue
    }
    open.lines.push(line)
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
      const value = open.lines.join('\n')
      if (value.includes(token)) blocks.push(value)
      open = null
    }
  }
  return blocks
}

function displayMathBlocksContaining(source, token) {
  const lines = String(source || '').split(/\r\n|\r|\n/)
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^ {0,3}\$\$\s*$/.test(lines[index])) continue
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!/^ {0,3}\$\$\s*$/.test(lines[cursor])) continue
      const block = lines.slice(index, cursor + 1).join('\n')
      if (block.includes(token)) blocks.push(block)
      index = cursor
      break
    }
  }
  return blocks
}

function assertSingleCompleteSourceBlock(source, token, label) {
  const blocks = slashBlockStyle === 'math'
    ? displayMathBlocksContaining(source, token)
    : fencedBlocksContaining(source, token)
  assert.equal(
    blocks.length,
    1,
    `${label} must contain exactly one complete ${slashBlockStyle} block around ${token}`
  )
}

function assertFenceInfo(source, token, expected, label) {
  if (!expected) return
  const block = fencedBlocksContaining(source, token)[0]
  assert.ok(block, `${label} is missing the fenced block around ${token}`)
  const opening = block.split(/\r\n|\r|\n/, 1)[0]
  const info = opening.replace(/^ {0,3}(`{3,}|~{3,})\s*/, '').trim()
  assert.equal(
    info.toLowerCase(),
    expected.toLowerCase(),
    `${label} lost Slash fence language: ${JSON.stringify(opening)}`
  )
}

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file],
    executable: testExecutable || undefined,
    entrypoint: testExecutable ? '' : undefined
  })
  await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`), 'editor did not mount')
  await sleep(700)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  if (sourceFile) await copyFile(sourceFile, file)
  else await writeFile(file, defaultFixture, 'utf8')
  const original = await readFile(file, 'utf8')
  const precedingAnchor = original.lastIndexOf('气氛 分')
  assert.ok(precedingAnchor >= 0, 'fixture is missing the preceding edit anchor')
  const untouchedPrefix = original.slice(0, precedingAnchor)
  let app
  try {
    app = await openApp('edit', port)
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmSourceTransactionLog = []
      window.__hmSourceTransactionTrace = []
      window.__hmListIntentTrace = []
      window.__hmSourceSyncCoordinatorTrace = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)

    await focusEnd(evaluate, send)
    if (slashFence) {
      await typeTextLikeUser(send, slashQuery, { delayMs: delay })
      await sleep(slashSettleMs)
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
      let slashPublication
      try {
        slashPublication = await waitFor(async () => {
          const trace = await evaluate(`window.__hmSourceSyncCoordinatorTrace || []`)
          return trace.find((entry) =>
            entry.phase === 'published' &&
            entry.boundary === 'slash-code-block-atomic' &&
            entry.owner === 'legacy' &&
            entry.family === 'legacy-preservation' &&
            entry.reason === 'slash-code-block-atomic'
          ) || null
        }, 'slash code command bypassed SourceSyncCoordinator')
      } catch (error) {
        const diagnostics = await evaluate(`(() => {
          const pm = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
          const blocks = [...(pm?.querySelectorAll('.milkdown-code-block') || [])]
          const selection = getSelection()
          return {
            query: ${JSON.stringify(slashQuery)},
            coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-20),
            integrity: (window.__hmSourceIntegrityTrace || []).slice(-20)
              .map(({ parsed, expected, ...entry }) => entry),
            preserve: (window.__hmPreserveLog || []).slice(-20),
            codeBlocks: blocks.map((node) => ({
              text: node.innerText || '',
              visible: !!node.offsetParent,
              language: node.querySelector('button.language-button')?.textContent || ''
            })),
            activeElement: document.activeElement?.className || document.activeElement?.tagName || '',
            domSelection: {
              text: selection?.toString() || '',
              anchorClass: selection?.anchorNode?.parentElement?.className || '',
              anchorOffset: selection?.anchorOffset ?? null
            }
          }
        })()`)
        throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`)
      }
      assert.ok(slashPublication.revision >= 1)
      await sleep(500)
      await typeTextLikeUser(send, marker, { delayMs: delay })
    } else {
      for (let i = 0; i < 3; i += 1) await typeBacktick(send)
    }
    if (!slashFence && inputRuleFence) {
      await typeSpace(send)
      await sleep(500)
      await typeTextLikeUser(send, marker, { delayMs: delay })
    } else if (!slashFence) {
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
      await sleep(400)
      await typeTextLikeUser(send, marker, { delayMs: delay })
      await sleep(400)
      await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
      await sleep(400)
      for (let i = 0; i < 3; i += 1) await typeBacktick(send)
    }
    await sleep(600)

    if (continuousPostFenceEdit) {
      // Do not source-switch/save as an artificial checkpoint. Continue with
      // ordinary edits immediately while the fence input-rule callbacks may
      // still be pending, matching a real uninterrupted writing session.
      await applyPostFenceEdits(app)
      assertEditedBlockState(await editedBlockState(evaluate), 'rich mode before source switch')
    }

    if (process.env.TAIL_FENCE_DIAGNOSTICS === '1') {
      console.log('tail fence DOM', JSON.stringify(await evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return {
          codeBlocks: editor?.querySelectorAll('.milkdown-code-block').length || 0,
          codeTexts: [...(editor?.querySelectorAll('.milkdown-code-block .cm-content') || [])]
            .slice(-3).map((node) => node.innerText),
          tailChildren: [...(editor?.children || [])].slice(-6).map((node) => ({
            tag: node.tagName,
            cls: node.className,
            text: node.innerText
          }))
        }
      })()`), null, 2))
    }

    if (slashFence) {
      const integrityFailures = await evaluate(`
        (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false)
      `)
      assert.equal(
        integrityFailures.length,
        0,
        `slash code publication had first-divergence failures: ${JSON.stringify(integrityFailures)}`
      )
    }
    const pauseToasts = await toasts(evaluate)
    assert.ok(
      !pauseToasts.some((t) => /保存已暂停|无法安全映射|原文件未被覆盖/.test(t || '')),
      `save-pause toast appeared: ${JSON.stringify(pauseToasts)}`
    )
    assert.equal(await toggleSource(evaluate), true, 'source toggle failed')
    const source = await waitFor(() => visibleSource(evaluate), 'source missing').catch(() => null)
    if (source === null) {
      console.error('tail fence source-lock diagnostics', JSON.stringify(await evaluate(`({
        preserve: (window.__hmPreserveLog || []).slice(-20).map((entry) => ({
          reason: entry.reason,
          preserved: entry.preserved,
          sourceTail: entry.source?.slice(-500),
          previousTail: entry.previous?.slice(-500),
          nextTail: entry.next?.slice(-500),
          markdownTail: entry.markdown?.slice(-500)
        })),
        transaction: (window.__hmSourceTransactionLog || []).slice(-20),
        transactionTrace: (window.__hmSourceTransactionTrace || []).slice(-20),
        listIntent: (window.__hmListIntentTrace || []).slice(-20),
        coordinator: (window.__hmSourceSyncCoordinatorTrace || []).slice(-20),
        integrity: (window.__hmSourceIntegrityTrace || []).slice(-20).map(({ parsed, expected, ...entry }) => entry),
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || '')
      })`), null, 2))
    }
    assert.ok(source !== null, 'source mode stayed locked')
    assert.ok(
      source.includes(marker),
      `fence content missing in source: ${JSON.stringify(source.slice(-160))}`
    )
    assertSingleCompleteSourceBlock(source, marker, 'source mode')
    assertFenceInfo(source, marker, expectedFenceInfo, 'source mode')
    if (slashFence) {
      const atomicReasons = await evaluate(`(window.__hmPreserveLog || [])
        .filter((entry) => entry.reason === 'slash-code-block-atomic').length`)
      assert.equal(atomicReasons, 1, 'slash code conversion did not publish one atomic source intent')
    }
    if (continuousPostFenceEdit) {
      for (const token of [codeEdit, trailingProse, precedingEdit]) {
        assert.equal(source.split(token).length - 1, 1, `continuous post-fence token missing or duplicated: ${token}`)
      }
    }
    console.log(`PASS tail fence (${fenceVariant}): hand-typed code block reached source without pause toast`)

    // Persistence leg: save via the FAB (background-mode Cmd+S does not hit
    // the menu accelerator), then fully reopen in a fresh profile and confirm
    // the fenced block renders and maps back to the exact bytes on disk.
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(2500)
    const disk1 = await readFile(file, 'utf8')
    assert.ok(
      disk1.includes(marker),
      `fence content missing after save: ${JSON.stringify(disk1.slice(-160))}`
    )
    assertSingleCompleteSourceBlock(disk1, marker, 'saved file')
    assertFenceInfo(disk1, marker, expectedFenceInfo, 'saved file')
    if (continuousPostFenceEdit) {
      for (const token of [codeEdit, trailingProse, precedingEdit]) {
        assert.equal(disk1.split(token).length - 1, 1, `continuous post-fence token missing or duplicated on disk: ${token}`)
      }
    }
    assert.equal(
      disk1.startsWith(continuousPostFenceEdit ? untouchedPrefix : original),
      true,
      'tail code-block editing changed bytes before the intentionally edited anchor'
    )
    await stopBuiltElectron(app, { removeProfile: false })
    app = await openApp('reopen', port + 1)
    const visible = await waitFor(() => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const codeBlock = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
        .find((node) => (node.innerText || '').includes(${JSON.stringify(marker)}))
      return codeBlock ? { documentText: editor.innerText || '', codeText: codeBlock.innerText || '' } : null
    })()`), 'reopen fenced code block missing')
    assert.ok(visible.documentText.includes(marker), 'fence content not visible after reopen')
    assert.ok(visible.codeText.includes(marker), 'fence content reopened as plain text instead of a code block')
    if (continuousPostFenceEdit) {
      assertEditedBlockState(await editedBlockState(app.evaluate), 'rich mode after cold reopen')
    }
    const disk2 = await readFile(file, 'utf8')
    assert.equal(disk1, disk2, 'file bytes changed across reopen')
    assert.equal(await toggleSource(app.evaluate), true, 'source toggle failed after reopen')
    const source2 = await waitFor(() => visibleSource(app.evaluate), 'source missing after reopen')
    assert.ok(
      source2.includes(marker),
      `fence content missing in source after reopen: ${JSON.stringify(source2.slice(-160))}`
    )
    assertSingleCompleteSourceBlock(source2, marker, 'source after reopen')
    assertFenceInfo(source2, marker, expectedFenceInfo, 'source after reopen')
    console.log(`PASS tail fence (${fenceVariant}): save + reopen kept bytes and source mapping exact`)

    if (continuousPostFenceEdit) {
      for (const token of [codeEdit, trailingProse, precedingEdit]) {
        assert.equal(source2.split(token).length - 1, 1, `continuous post-fence token differs after reopen: ${token}`)
      }
      console.log(`PASS tail fence (${fenceVariant}, continuous): later edits stayed exact without an intermediate checkpoint`)
      return
    }

    // The original regression only stopped after the first reopen. Continue
    // editing the code block itself, the paragraph after it, and preceding
    // authored content, then source-switch/save/cold-reopen again. This is the
    // actual family failure reported by users: the first fence is present, but
    // a later edit makes the rich/source snapshots diverge.
    assert.equal(await toggleSource(app.evaluate), true, 'return to rich failed before post-fence edits')
    await applyPostFenceEdits(app)

    assert.equal(await toggleSource(app.evaluate), true, 'source toggle failed after post-fence edits')
    const source3 = await waitFor(() => visibleSource(app.evaluate), 'source missing after post-fence edits')
    for (const token of [marker, codeEdit, trailingProse, precedingEdit]) {
      assert.equal(
        source3.split(token).length - 1,
        1,
        `post-fence token must appear exactly once in source: ${token}`
      )
    }
    assert.ok(
      !/(?:保存已暂停|无法安全映射|原文件未被覆盖)/.test((await toasts(app.evaluate)).join('\n')),
      'post-fence edits triggered source-sync pause'
    )
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(async () => (await readFile(file, 'utf8')).includes(trailingProse), 'post-fence save did not reach disk')
    const disk3 = await readFile(file, 'utf8')
    assert.equal(
      source3,
      disk3.replace(/\r\n?|\u2028|\u2029/g, '\n'),
      'post-fence source textarea and disk differ'
    )

    await stopBuiltElectron(app, { removeProfile: false })
    app = await openApp('reopen-after-edit', port + 2)
    const richAfterEdit = await waitFor(() => app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return editor?.innerText || ''
    })()`), 'post-fence cold reopen render missing')
    for (const token of [marker, codeEdit, trailingProse, precedingEdit]) {
      assert.equal(richAfterEdit.includes(token), true, `post-fence token missing after cold reopen: ${token}`)
    }
    assert.equal(await readFile(file, 'utf8'), disk3, 'post-fence disk bytes changed across cold reopen')
    assert.equal(await toggleSource(app.evaluate), true, 'source toggle failed after post-fence cold reopen')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'source missing after post-fence cold reopen'),
      disk3.replace(/\r\n?|\u2028|\u2029/g, '\n'),
      'post-fence source differs after cold reopen'
    )
    console.log(`PASS tail fence (${fenceVariant}): later code/prose/preceding edits stay exact through source, save, and reopen`)
  } finally {
    try {
      await stopBuiltElectron(app, { removeProfile: true })
    } catch {}
    if (process.env.KEEP_TAIL_FENCE_FIXTURE !== '1') {
      try { await rm(root, { recursive: true, force: true }) } catch {}
    } else {
      console.log(`KEEP tail fence fixture: ${file}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
