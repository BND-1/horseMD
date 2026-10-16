import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9697)
const template = join(process.cwd(), 'scripts', 'fixtures', 'inline-code-input.md')
const root = `/tmp/horsemd-inline-code-ui-${process.pid}`
const fixture = join(root, 'inline-code-input.md')
let compositionId = 1

async function waitFor(check, message, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const warningToasts = (evaluate) => evaluate(`
  [...document.querySelectorAll('[class*="toast"]')]
    .map((node) => node.textContent || '')
    .filter((text) => /保存已暂停|无法安全映射|原文件未被覆盖|Save paused|rich text.*source/i.test(text))
`)

async function openApp(profile, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [fixture],
    executable: process.env.HORSEMD_APP_PATH || undefined,
    entrypoint: process.env.HORSEMD_APP_PATH ? null : undefined
  })
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')].some((node) => node.offsetParent)`),
    'inline-code fixture did not render'
  )
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror')]
      .filter((node) => node.offsetParent)
      .some((editor) => [...editor.querySelectorAll('p')].some((node) => node.textContent.includes('Type target')))`),
    'inline-code input target did not render'
  )
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(fixture, await readFile(template))

  let app
  try {
    app = await openApp('profile-1', port)
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__hmSourceSyncCoordinatorTrace = []
      window.__hmSourceIntegrityTrace = []
      window.__hmSourceIntegrityDiffTrace = []
    })()`)
    const caretPoint = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...(editor?.querySelectorAll('p') || [])]
        .find((node) => node.textContent.includes('Type target'))
      const rect = paragraph?.getBoundingClientRect()
      return rect ? { x: rect.right - 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(caretPoint, 'could not locate the real editor input target')
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: caretPoint.x, y: caretPoint.y, button: 'left', clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: caretPoint.x, y: caretPoint.y, button: 'left', clickCount: 1
    })
    await sleep(100)

    const typeBacktick = async () => {
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

    const typeCharacter = async (character) => {
      const upper = character.toUpperCase()
      const code = `Key${upper}`
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

    const imeType = async (pinyin, text) => {
      const replacementId = `inline-code-${compositionId++}`
      for (let index = 0; index < pinyin.length; index += 1) {
        const character = pinyin[index]
        const code = `Key${character.toUpperCase()}`
        const virtualKeyCode = character.toUpperCase().charCodeAt(0)
        await send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown', key: character, code,
          windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode
        })
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: character, code,
          windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode
        })
        const composing = pinyin.slice(0, index + 1)
        await send('Input.imeSetComposition', {
          text: composing,
          selectionStart: composing.length,
          selectionEnd: composing.length,
          replacementId,
          location: 0
        })
        await sleep(45)
      }
      await send('Input.insertText', { text })
      await sleep(100)
    }

    const pressArrowRight = async () => {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
        nativeVirtualKeyCode: 39
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
        nativeVirtualKeyCode: 39
      })
      await sleep(80)
    }

    // The opening delimiter and a real Chinese IME composition remain literal
    // until the user types the final delimiter. This is the product contract:
    // no hidden inline-code state may activate on the first committed CJK text.
    await typeBacktick()
    await imeType('zhongwen', '中文')
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        const paragraph = [...(editor?.querySelectorAll('p') || [])]
          .find((node) => node.textContent.includes('Type target'))
        return Boolean(
          paragraph?.textContent.endsWith('\`中文') &&
          !paragraph.querySelector('code') &&
          !editor.querySelector('.hm-inline-code-delimiter')
        )
      })()`),
      'opening backtick plus Chinese IME text activated inline code before closure'
    )
    await typeBacktick()
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        const code = [...(editor?.querySelectorAll('code') || [])].find((node) => node.textContent === '中文')
        return Boolean(code && !editor.querySelector('.hm-inline-code-delimiter'))
      })()`),
      'closing backtick did not create inline code'
    )

    const codeEdge = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const code = [...(editor?.querySelectorAll('code') || [])].find((node) => node.textContent === '中文')
      const rect = code?.getBoundingClientRect()
      return rect ? { x: rect.right - 1, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(codeEdge, 'could not locate rendered inline code')
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...codeEdge, button: 'left', clickCount: 1
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...codeEdge, button: 'left', clickCount: 1
    })
    await sleep(100)
    await pressArrowRight()
    assert.equal(
      await evaluate(`document.querySelectorAll('.hm-inline-code-delimiter').length`),
      0,
      'inline-code delimiters should hide after ArrowRight exits the trailing boundary'
    )
    assert.equal(
      await evaluate(`(() => {
        const selection = document.getSelection()
        return Boolean(selection?.anchorNode?.parentElement?.closest?.('code'))
      })()`),
      false,
      'ArrowRight left the logical mark but the visible DOM caret remained inside <code>'
    )
    for (const character of 'outside') {
      await typeCharacter(character)
    }
    const afterExit = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...(editor?.querySelectorAll('p') || [])]
        .find((node) => node.textContent.includes('Type target'))
      const code = [...(paragraph?.querySelectorAll('code') || [])]
        .find((node) => node.textContent.includes('中文'))
      return {
        code: code?.textContent || '',
        paragraph: paragraph?.textContent || ''
      }
    })()`)
    assert.deepEqual(afterExit, {
      code: '中文',
      paragraph: 'Type target中文outside'
    })
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    })
    await send('Input.dispatchKeyEvent', {
      type: 'char', key: 'Enter', code: 'Enter', text: '\\r', unmodifiedText: '\\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    })
    await typeBacktick()
    for (const character of 'feaef') {
      await typeCharacter(character)
    }
    await typeBacktick()
    for (const character of '212afea') {
      await typeCharacter(character)
    }
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    })
    for (let index = 0; index < 3; index += 1) {
      await typeBacktick()
    }
    await imeType('nihao', '你好')
    for (let index = 0; index < 3; index += 1) {
      await typeBacktick()
    }
    const literalTripleRun = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...(editor?.querySelectorAll('p') || [])]
        .find((node) => node.textContent === '\`\`\`你好\`\`\`')
      return {
        text: paragraph?.textContent || '',
        codeCount: paragraph?.querySelectorAll('code').length ?? -1
      }
    })()`)
    assert.deepEqual(literalTripleRun, {
      text: '```你好```',
      codeCount: 0
    }, 'same-line triple-backtick text should remain a literal paragraph before source switch')
    const richTextBeforeSource = await evaluate(`[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent || ''`)

    assert.equal(await evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\//.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`), true, 'could not open source mode')
    let source
    try {
      source = await waitFor(
        () => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value || null`),
        'source editor did not open'
      )
    } catch (error) {
      const diagnostic = await evaluate(`(() => ({
        coordinator: window.__hmSourceSyncCoordinatorTrace || [],
        integrity: window.__hmSourceIntegrityTrace || [],
        flush: window.__hmFlushTrace || [],
        toasts: [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent || ''),
        visibleSourceCount: [...document.querySelectorAll('textarea.source-editor')].filter((node) => node.offsetParent).length,
        visibleRichCount: [...document.querySelectorAll('.ProseMirror')].filter((node) => node.offsetParent).length,
        saveVisible: !!document.querySelector('.hm-save-fab')
      }))()`)
      console.error('INLINE_CODE_SOURCE_TOGGLE_DIAGNOSTIC', JSON.stringify(diagnostic))
      throw error
    }
    assert.ok(
      source.includes('`中文`outside\n\n`feaef`212afea') &&
        source.split(/\r?\n/).includes('```你好```') &&
        !source.includes('\\`\\`\\`你好\\`\\`\\`'),
      `inline-code exit or triple backticks changed in Markdown: ${JSON.stringify(source)}; rich text was: ${richTextBeforeSource}`
    )

    const publication = await waitFor(async () => {
      const trace = await evaluate(`window.__hmSourceSyncCoordinatorTrace || []`)
      return trace.find((entry) =>
        entry.phase === 'published' &&
        entry.boundary === 'inline-code-value-change' &&
        entry.owner === 'legacy' &&
        entry.family === 'legacy-preservation'
      ) || null
    }, 'inline-code plugin publication bypassed SourceSyncCoordinator')
    assert.ok(publication.revision >= 1)
    const integrityFailures = await evaluate(`
      (window.__hmSourceIntegrityTrace || []).filter((entry) => entry?.ok === false)
    `)
    assert.equal(
      integrityFailures.length,
      0,
      `inline-code publication had first-divergence failures: ${JSON.stringify(integrityFailures)}`
    )
    assert.equal((await warningToasts(evaluate)).length, 0, 'inline-code publication showed a warning toast')

    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode before inline-code save')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'inline-code save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'inline-code save did not finish')
    assert.equal(await readFile(fixture, 'utf8'), source, 'inline-code coordinator publication did not reach disk exactly')

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await openApp('profile-2', port + 1)
    assert.equal(await toggleSource(app.evaluate), true, 'could not open source after inline-code cold reopen')
    const reopenedSource = await waitFor(
      () => visibleSource(app.evaluate),
      'inline-code cold-reopen source did not appear'
    )
    assert.equal(reopenedSource, source, 'inline-code source changed after cold reopen')

    console.log('PASS inline code UI: plugin publication uses SourceSyncCoordinator; IME, source, save, and cold reopen are exact')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
