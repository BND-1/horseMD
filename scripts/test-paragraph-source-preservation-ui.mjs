import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const dir = '/tmp/horsemd-paragraph-source-preservation'
const file = join(dir, 'paragraphs.md')
const newDocumentFile = join(dir, 'new-document.md')
const bodyFirstFile = join(dir, 'body-first.md')
const port = Number(process.env.CDP_PORT || 9487)
const original = [
  '紧凑第一行',
  '紧凑第二行',
  '',
  '标准段落 A',
  '',
  '标准段落 B'
].join('\n')

async function waitFor(check, message, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
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

const nativeClick = async (evaluate, send, expression) => {
  const point = await evaluate(`(() => {
    const node = ${expression}
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `native click target missing: ${expression}`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
}

const nativeToggleSource = (evaluate, send) => nativeClick(
  evaluate,
  send,
  `[...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))`
)

const placeCaretAfter = (evaluate, needle) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return false
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const index = node.nodeValue.indexOf(${JSON.stringify(needle)})
    if (index < 0) continue
    const range = document.createRange()
    range.setStart(node, index + ${JSON.stringify(needle)}.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  }
  return false
})()`)

const pressEnter = async (send) => {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
}

const typeNativeCharacter = async (send, character) => {
  const isDigit = /^\d$/.test(character)
  const upper = character.toUpperCase()
  const code = isDigit ? `Digit${character}` : `Key${upper}`
  const virtualKeyCode = upper.charCodeAt(0)
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: character,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    key: character,
    code,
    text: character,
    unmodifiedText: character,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: character,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  })
  await sleep(35)
}

const typeBacktick = async (send) => {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  })
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    key: '`',
    code: 'Backquote',
    text: '`',
    unmodifiedText: '`',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: '`',
    code: 'Backquote',
    windowsVirtualKeyCode: 192,
    nativeVirtualKeyCode: 192
  })
  await sleep(80)
}

const visibleSourceCaret = (evaluate) => evaluate(`(() => {
  const textarea = [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)
  return textarea
    ? { start: textarea.selectionStart, end: textarea.selectionEnd, value: textarea.value }
    : null
})()`)

const richCaret = (evaluate) => evaluate(`(() => {
  const selection = getSelection()
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const node = selection?.anchorNode
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
  const paragraph = element?.closest?.('p')
  if (!editor || !paragraph || !editor.contains(paragraph) || !selection.rangeCount) return null
  const before = document.createRange()
  before.selectNodeContents(paragraph)
  before.setEnd(selection.anchorNode, selection.anchorOffset)
  return {
    text: paragraph.textContent,
    offset: before.toString().length,
    collapsed: selection.isCollapsed
  }
})()`)

const typeHumanPaced = async (send, text) => {
  await typeTextLikeUser(send, text, { delayMs: 120 })
  // Let Crepe publish this block's canonical snapshot before Enter. Without
  // this pause, CDP batches all blocks into one update and misses the real
  // hand-typing path that previously merged later paragraphs into the title.
  await sleep(1200)
}

async function writeNewDocument({ path, profile, port: scenarioPort, startBlock, expected }) {
  const app = await launchBuiltElectron({
    profileDir: join(dir, profile),
    port: scenarioPort,
    appArgs: [path],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`(() => {
        const tab = document.querySelector('.tab.active')
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor && (tab?.textContent || '').includes(${JSON.stringify(basename(path))})
      })()`),
      'empty rich editor did not open'
    )
    await nativeClick(
      evaluate,
      send,
      `[...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.querySelector(${JSON.stringify(startBlock)})`
    )
    await typeHumanPaced(send, startBlock === 'h1' ? '新建标题' : '正文第一段')
    await pressEnter(send)
    await typeHumanPaced(send, startBlock === 'h1' ? '正文第一段' : '正文第二段')
    if (startBlock === 'h1') {
      await pressEnter(send)
      await typeHumanPaced(send, '正文第二段')
    }

    // Deliberately switch in the same task sequence: no save and no wait for
    // markdownUpdated. This is the exact path that previously mounted an
    // uncontrolled textarea from the stale empty tab snapshot.
    await nativeToggleSource(evaluate, send)
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source mode did not open for a new document'),
      expected,
      'new-document paragraphs disappeared or merged during an immediate source switch'
    )

    await nativeToggleSource(evaluate, send)
    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'new-document save button did not appear'
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('.hm-save-fab')`),
      'new-document save did not finish'
    )
    assert.equal(await readFile(path, 'utf8'), expected)
  } finally {
    await stopBuiltElectron(app)
  }
}

async function verifyNewDocumentReopen({ path, profile, port: scenarioPort, expected, heading }) {
  const app = await launchBuiltElectron({
    profileDir: join(dir, profile),
    port: scenarioPort,
    appArgs: [path],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor && editor.textContent.includes(${JSON.stringify('正文第一段')})
      })()`),
      'new document did not reopen'
    )
    const blocks = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return [...editor.children]
        .filter((node) => /^(H1|P)$/.test(node.tagName))
        .map((node) => ({ tag: node.tagName, text: node.textContent }))
    })()`)
    assert.deepEqual(
      blocks,
      heading
        ? [
            { tag: 'H1', text: '新建标题' },
            { tag: 'P', text: '正文第一段' },
            { tag: 'P', text: '正文第二段' }
          ]
        : [
            { tag: 'P', text: '正文第一段' },
            { tag: 'P', text: '正文第二段' }
          ]
    )
    await nativeToggleSource(evaluate, send)
    assert.equal(await waitFor(() => visibleSource(evaluate), 'reopened source mode did not open'), expected)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function editAndSave() {
  const app = await launchBuiltElectron({
    profileDir: join(dir, 'edit-profile'),
    port,
    appArgs: [file],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  const { evaluate, send } = app

  try {
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return editor?.textContent?.includes('紧凑第二行') || false
      })()`),
      'rich editor did not open'
    )
    if (process.env.TRANSACTION_TRACE === '1') {
      await evaluate(`(() => {
        window.__hmSourceTransactionTrace = []
        window.__hmSourceTransactionLog = []
        window.__hmPreserveLog = []
      })()`)
    }

    assert.equal(await placeCaretAfter(evaluate, '紧凑第二行'), true)
    await send('Input.insertText', { text: 'X' })
    await sleep(350)
    assert.equal(await toggleSource(evaluate), true)
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source mode did not open after compact-line edit'),
      original.replace('紧凑第二行', '紧凑第二行X'),
      'editing a compact source line inserted blank lines elsewhere'
    )

    assert.equal(await toggleSource(evaluate), true)
    assert.equal(await placeCaretAfter(evaluate, '标准段落 A'), true)
    await pressEnter(send)
    await sleep(1200)
    await send('Input.insertText', { text: '中间新段落' })
    await sleep(1200)
    await pressEnter(send)
    await sleep(1200)
    await pressEnter(send)
    await sleep(1200)
    await send('Input.insertText', { text: '中间间隔段落' })

    const expectedMiddle = original
      .replace('紧凑第二行', '紧凑第二行X')
      .replace('标准段落 A', '标准段落 A\n\n中间新段落\n\n\n\n中间间隔段落')
    assert.equal(await toggleSource(evaluate), true)
    const middleSource = await waitFor(
      () => visibleSource(evaluate),
      'source mode did not open after middle paragraph insert'
    )
    if (process.env.TRANSACTION_TRACE === '1' && middleSource !== expectedMiddle) {
      const trace = await evaluate(`({
        transactions: window.__hmSourceTransactionTrace || [],
        mapped: window.__hmSourceTransactionLog || [],
        preserved: window.__hmPreserveLog || []
      })`)
      console.error('TRANSACTION_TRACE', JSON.stringify(trace, null, 2))
    }
    assert.equal(
      middleSource,
      expectedMiddle,
      'paragraphs inserted before an existing block merged or leaked a <br /> placeholder'
    )

    assert.equal(await toggleSource(evaluate), true)
    assert.equal(await placeCaretAfter(evaluate, '中间间隔段落'), true)
    await pressEnter(send)
    await send('Input.insertText', { text: '中间快速段落' })

    const expectedMiddleFast = expectedMiddle
      .replace('中间间隔段落', '中间间隔段落\n\n中间快速段落')
    assert.equal(await toggleSource(evaluate), true)
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source mode did not open after immediate middle paragraph insert'),
      expectedMiddleFast,
      'typing immediately after Enter before an existing block merged into the preceding paragraph'
    )

    assert.equal(await toggleSource(evaluate), true)
    assert.equal(await placeCaretAfter(evaluate, '标准段落 B'), true)
    await pressEnter(send)
    await send('Input.insertText', { text: '新建段落 C' })
    await pressEnter(send)
    await send('Input.insertText', { text: '连续段落 D' })

    const expected = expectedMiddleFast
      .replace('标准段落 B', '标准段落 B\n\n新建段落 C\n\n连续段落 D')
    assert.equal(await toggleSource(evaluate), true)
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source mode did not open after paragraph append'),
      expected,
      'an immediate rich/source switch lost or flattened the new paragraph'
    )

    assert.equal(await toggleSource(evaluate), true)
    assert.equal(await placeCaretAfter(evaluate, '连续段落 D'), true)
    await pressEnter(send)
    await typeBacktick(send)
    for (const character of 'feaef') await typeNativeCharacter(send, character)
    // Inline code now follows the explicit closing-delimiter contract: the
    // first backtick stays literal and only the final backtick creates the mark.
    await typeBacktick(send)
    for (const character of '212afea') await typeNativeCharacter(send, character)

    const expectedWithInlineCode = expected + '\n\n`feaef`212afea'
    assert.equal(await toggleSource(evaluate), true)
    const firstSourceCaret = await waitFor(
      async () => {
        const caret = await visibleSourceCaret(evaluate)
        return caret?.value === expectedWithInlineCode && caret.start === expectedWithInlineCode.length
          ? caret
          : null
      },
      'new trailing inline-code paragraph merged or its source caret drifted'
    )
    assert.deepEqual(firstSourceCaret, {
      start: expectedWithInlineCode.length,
      end: expectedWithInlineCode.length,
      value: expectedWithInlineCode
    })

    assert.equal(await toggleSource(evaluate), true)
    assert.deepEqual(
      await waitFor(
        async () => {
          const caret = await richCaret(evaluate)
          return caret?.text === 'feaef212afea' && caret.offset === caret.text.length
            ? caret
            : null
        },
        'source-to-rich caret did not return to the trailing inline-code paragraph'
      ),
      { text: 'feaef212afea', offset: 12, collapsed: true }
    )

    assert.equal(await toggleSource(evaluate), true)
    const secondSourceCaret = await waitFor(
      async () => {
        const caret = await visibleSourceCaret(evaluate)
        return caret?.value === expectedWithInlineCode && caret.start === expectedWithInlineCode.length
          ? caret
          : null
      },
      'rich-to-source caret drifted after the second inline-code switch'
    )
    assert.equal(secondSourceCaret.end, expectedWithInlineCode.length)

    assert.equal(await toggleSource(evaluate), true)
    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'save button did not appear'
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('.hm-save-fab')`),
      'save did not finish'
    )
    assert.equal(
      await readFile(file, 'utf8'),
      expectedWithInlineCode,
      'saved Markdown differs from the source snapshot'
    )
    return expectedWithInlineCode
  } finally {
    await stopBuiltElectron(app)
  }
}

async function reopenAndVerify(expected) {
  const app = await launchBuiltElectron({
    profileDir: join(dir, 'reopen-profile'),
    port: port + 1,
    appArgs: [file],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  const { evaluate } = app

  try {
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return editor?.textContent?.includes('连续段落 D') || false
      })()`),
      'saved document did not reopen'
    )
    const paragraphs = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return [...editor.querySelectorAll(':scope > p')].map((node) => node.textContent)
    })()`)
    assert.deepEqual(
      paragraphs,
      [
        '紧凑第一行 紧凑第二行X',
        '标准段落 A',
        '中间新段落',
        '中间间隔段落',
        '中间快速段落',
        '标准段落 B',
        '新建段落 C',
        '连续段落 D',
        'feaef212afea'
      ],
      'saved paragraph structure changed after a clean reopen'
    )
    assert.equal(await toggleSource(evaluate), true)
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source mode did not open after clean reopen'),
      expected
    )
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, original, 'utf8')
  await writeFile(newDocumentFile, '', 'utf8')
  await writeFile(bodyFirstFile, '', 'utf8')
  const newDocumentExpected = '# 新建标题\n\n正文第一段\n\n正文第二段\n'
  const bodyFirstExpected = '正文第一段\n\n正文第二段\n'
  await writeNewDocument({
    path: newDocumentFile,
    profile: 'new-document-profile',
    port: port + 2,
    startBlock: 'h1',
    expected: newDocumentExpected
  })
  await verifyNewDocumentReopen({
    path: newDocumentFile,
    profile: 'new-document-reopen-profile',
    port: port + 3,
    expected: newDocumentExpected,
    heading: true
  })
  await writeNewDocument({
    path: bodyFirstFile,
    profile: 'body-first-profile',
    port: port + 4,
    startBlock: 'p',
    expected: bodyFirstExpected
  })
  await verifyNewDocumentReopen({
    path: bodyFirstFile,
    profile: 'body-first-reopen-profile',
    port: port + 5,
    expected: bodyFirstExpected,
    heading: false
  })
  const expected = await editAndSave()
  await reopenAndVerify(expected)
  console.log('PASS paragraph source UI: new documents and existing text survive immediate source switches and clean reopen')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
