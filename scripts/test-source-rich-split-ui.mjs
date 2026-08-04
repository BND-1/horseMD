import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const dir = '/tmp/horsemd-source-rich-split'
const file = join(dir, 'split-preview.md')
const port = Number(process.env.CDP_PORT || 9885)
const source = `# 双栏预览\n\n开头段落。\n\n## 页面对应关系\n\n${Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：滚动联动与源码保真测试内容。`).join('\n\n')}\n\n- 保持短横线列表\n- 第二项\n`

async function waitFor(check, message, attempts = 100, delay = 25) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(delay)
  }
  throw new Error(message)
}

async function toggleSplitPreview(evaluate) {
  const opened = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const target = editor?.querySelector('p, h1, h2') || editor
    if (!target) return false
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + Math.min(24, rect.width / 2)),
      clientY: Math.round(rect.top + Math.min(20, rect.height / 2))
    }))
    return true
  })()`)
  assert.equal(opened, true, 'Could not open the rich editor context menu')
  await waitFor(
    () => evaluate(`!!document.querySelector('[data-source-rich-toggle]')`),
    'Source + preview was not available from the rich editor context menu'
  )
  await evaluate(`document.querySelector('[data-source-rich-toggle]')?.click()`)
}


async function placeSourceCaretAtEnd(evaluate) {
  const placed = await evaluate(`(() => {
    const el = document.querySelector('textarea.source-editor.hm-source-rich-left')
    if (!el) return false
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    return true
  })()`)
  assert.equal(placed, true, 'Could not focus source pane')
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function toggleNormalSourceMode({ evaluate, send }) {
  const point = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-right .status-btn')]
      .find((node) => /Ctrl\\+\\/|⌘\\//.test(node.title || ''))
    const rect = button?.getBoundingClientRect()
    return rect && button.offsetParent ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'Could not locate the normal source/rich mode control')
  await click(send, point)
}

// Use a real browser mouse click at the leading edge of a populated source
// line. This catches regressions where the custom thick caret visually covers
// the first glyph even though textarea.selectionStart is correctly zero.
async function assertLeadingSourceCaret({ evaluate, send }, selector, text) {
  const target = await evaluate(`(() => {
    const textarea = document.querySelector(${JSON.stringify(selector)})
    const offset = textarea?.value.indexOf(${JSON.stringify(text)}) ?? -1
    if (!textarea || offset < 0) return null
    textarea.scrollTop = 0
    const line = textarea.value.slice(0, offset).split('\\n').length - 1
    const rect = textarea.getBoundingClientRect()
    const style = getComputedStyle(textarea)
    return {
      offset,
      // Click into the first glyph, not merely in the padding. Chromium has
      // historically placed this at offset +1 for Markdown punctuation/CJK;
      // source caret handling must snap that leading hit area back to offset 0.
      x: rect.left + parseFloat(style.paddingLeft) + Math.max(4, parseFloat(style.fontSize) * 0.55),
      y: rect.top + parseFloat(style.paddingTop) + (line * parseFloat(style.lineHeight)) + (parseFloat(style.fontSize) / 2),
      textStartX: rect.left + parseFloat(style.paddingLeft)
    }
  })()`)
  assert.ok(target, `Could not locate source text ${text}`)
  await click(send, target)
  try {
    await waitFor(() => evaluate(`(() => {
      const textarea = document.querySelector(${JSON.stringify(selector)})
      return textarea?.selectionStart === ${target.offset} && textarea.selectionEnd === ${target.offset}
    })()`), `Mouse click could not place the source caret before ${text}`)
  } catch {
    const actual = await evaluate(`(() => {
      const textarea = document.querySelector(${JSON.stringify(selector)})
      return textarea && { selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, scrollTop: textarea.scrollTop, valueAtSelection: textarea.value.slice(textarea.selectionStart - 12, textarea.selectionStart + 12) }
    })()`)
    throw new Error(`Mouse click could not place the source caret before ${text}: ${JSON.stringify({ target, actual })}`)
  }
  const result = await waitFor(() => evaluate(`(() => {
    const caret = document.querySelector('.hm-source-caret')?.getBoundingClientRect()
    return caret?.width ? { caretLeft: caret.left, caretRight: caret.right } : null
  })()`), `Custom source caret did not render after clicking before ${text}`)
  assert.ok(result.caretLeft < target.textStartX && result.caretRight <= target.textStartX + 1,
    `Wide source caret covered the first glyph instead of sitting before it: ${JSON.stringify({ result, target })}`)
}



async function main() {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, source, 'utf8')
  const app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port, appArgs: [file] })
  try {
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent && node.dataset.horsemdReady === 'true')`),
      'Rich editor did not become ready'
    )
    assert.equal(await evaluate(`!!document.querySelector('.hm-source-rich-toggle')`), false, 'Source + preview must not occupy the status bar')
    await toggleSplitPreview(evaluate)

    const layout = await waitFor(() => evaluate(`(() => {
      const source = document.querySelector('textarea.source-editor.hm-source-rich-left')
      const rich = document.querySelector('.editor-scroll.hm-source-rich-right')
      const host = rich?.querySelector('.editor-host')
      if (!source || !rich || !host || !source.offsetParent || !rich.offsetParent) return null
      const l = source.getBoundingClientRect(), r = rich.getBoundingClientRect(), h = host.getBoundingClientRect()
      const sourceStyle = getComputedStyle(source)
      return {
        sourceLeft: l.left, sourceRight: l.right, richLeft: r.left, richRight: r.right,
        hostLeft: h.left, hostRight: h.right,
        sourcePaddingRight: sourceStyle.paddingRight,
        sourcePaddingBottom: sourceStyle.paddingBottom,
        hostPaddingLeft: getComputedStyle(host).paddingLeft,
        hostPaddingRight: getComputedStyle(host).paddingRight,
        hostPaddingBottom: getComputedStyle(host).paddingBottom
      }
    })()`), 'Source + rich panes did not become visible together')
    assert.ok(layout.sourceRight <= layout.richLeft + 8, `Panes overlap: ${JSON.stringify(layout)}`)
    assert.ok(Math.abs(layout.hostLeft - layout.richLeft) <= 2 && Math.abs(layout.hostRight - layout.richRight) <= 12,
      `Rich preview host did not fill its panel: ${JSON.stringify(layout)}`)
    assert.equal(layout.sourcePaddingRight, '32px', `Source pane retained the single-view empty strip: ${JSON.stringify(layout)}`)
    assert.equal(layout.hostPaddingLeft, '32px', `Rich preview retained the single-view empty strip: ${JSON.stringify(layout)}`)
    assert.equal(layout.hostPaddingRight, '32px', `Rich preview retained the single-view empty strip: ${JSON.stringify(layout)}`)
    assert.equal(layout.sourcePaddingBottom, layout.hostPaddingBottom,
      `Source pane retained more bottom scroll room than rich preview: ${JSON.stringify(layout)}`)
    assert.equal(await evaluate(`!!document.querySelector('.tab-close.dirty')`), false, 'Opening split preview incorrectly marked the document dirty')

    await assertLeadingSourceCaret({ evaluate, send }, 'textarea.source-editor.hm-source-rich-left', '## 页面对应关系')

    // Source -> rich: every committed character goes through the normal input
    // path; only the final settled source snapshot may update the projection.
    await placeSourceCaretAtEnd(evaluate)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await typeTextLikeUser(send, '## 源码实时标题')
    const afterSource = await evaluate(`document.querySelector('textarea.source-editor.hm-source-rich-left')?.value || ''`)
    assert.ok(afterSource.includes('## 源码实时标题'), 'Source textarea lost its authored heading')

    // Saving must honor the authored source immediately, before the 180ms rich
    // projection debounce can run. This is the durability boundary that
    // prevents a stale ProseMirror serializer from overwriting source typed
    // just before Cmd/Ctrl+S.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'Source edit did not expose Save')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      async () => (await readFile(file, 'utf8')).includes('## 源码实时标题'),
      'Immediate source save wrote a stale rich snapshot'
    )
    await waitFor(
      () => evaluate(`document.querySelector('.editor-scroll.hm-source-rich-right .ProseMirror')?.textContent.includes('源码实时标题')`),
      'Source edit did not reach rich preview'
    )

    // The rich side is deliberately a preview: it cannot accept editing,
    // show block/selection affordances, open HorseMD's context menu, or turn
    // a click into an unsaved edit. It still remains scrollable for comparison.
    const previewContract = await evaluate(`(() => {
      const rich = document.querySelector('.editor-scroll.hm-source-rich-right .ProseMirror')
      const root = document.querySelector('.editor-scroll.hm-source-rich-right')
      if (!rich || !root) return null
      const rect = rich.getBoundingClientRect()
      rich.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + 18),
        clientY: Math.round(rect.top + 18)
      }))
      rich.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: Math.round(rect.left + 18), clientY: Math.round(rect.top + 18) }))
      return {
        editable: rich.getAttribute('contenteditable'),
        toolbarDisplay: (() => {
          const toolbar = root.querySelector('.milkdown-toolbar')
          return toolbar ? getComputedStyle(toolbar).display : 'missing'
        })(),
        blockHandleDisplay: (() => {
          const handle = root.querySelector('.milkdown-block-handle')
          return handle ? getComputedStyle(handle).display : 'missing'
        })(),
        hasContextMenu: !!document.querySelector('.block-ctxmenu'),
        dirty: !!document.querySelector('.tab-close.dirty')
      }
    })()`)
    assert.deepEqual(previewContract, {
      editable: 'false', toolbarDisplay: 'none', blockHandleDisplay: 'none', hasContextMenu: false, dirty: false
    }, `Rich side was not a non-editing preview: ${JSON.stringify(previewContract)}`)

    // The source edit was already saved before preview refresh. Preview-side
    // reading must not manufacture a second save/dirty state.
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false, 'Preview interaction incorrectly exposed Save')

    // Alternate source/rich scroll ownership ten times. The opposite pane must
    // follow without a reset to the document top or an infinite bounce.
    for (let index = 0; index < 10; index += 1) {
      const side = index % 2 === 0 ? 'source' : 'rich'
      const ratio = 0.16 + ((index * 0.071) % 0.68)
      const values = await evaluate(`(() => {
        const source = document.querySelector('textarea.source-editor.hm-source-rich-left')
        const rich = document.querySelector('.editor-scroll.hm-source-rich-right')
        const target = ${JSON.stringify(side)} === 'source' ? source : rich
        if (!source || !rich || !target) return null
        target.scrollTop = ${ratio} * Math.max(0, target.scrollHeight - target.clientHeight)
        target.dispatchEvent(new Event('scroll'))
        return { sourceTop: source.scrollTop, richTop: rich.scrollTop }
      })()`)
      assert.ok(values, 'Split scroll surfaces disappeared')
      await sleep(120)
      const followed = await evaluate(`(() => {
        const source = document.querySelector('textarea.source-editor.hm-source-rich-left')
        const rich = document.querySelector('.editor-scroll.hm-source-rich-right')
        return source && rich ? { sourceTop: source.scrollTop, richTop: rich.scrollTop } : null
      })()`)
      assert.ok(followed, 'Split scroll surfaces disappeared after sync')
      const opposite = side === 'source' ? followed.richTop : followed.sourceTop
      assert.ok(opposite > 10, `Scroll ${index + 1} did not move the ${side === 'source' ? 'rich' : 'source'} pane`)
    }

    // A visible in-panel close returns directly to the normal rich view; users
    // no longer have to discover that the status-bar mode toggle also exits.
    await evaluate(`document.querySelector('.hm-source-rich-close')?.click()`)
    await waitFor(
      () => evaluate(`!document.querySelector('textarea.source-editor') && !![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'In-panel close did not return to the normal rich view'
    )
    await toggleNormalSourceMode({ evaluate, send })
    await waitFor(
      () => evaluate(`!!document.querySelector('textarea.source-editor') && !document.querySelector('textarea.source-editor.hm-source-rich-left')`),
      'Source/rich control did not enter normal source mode'
    )
    // Simulate the user returning to the top before clicking the leading edge.
    // Marking this as a user selection suppresses the mode-switch settle retry,
    // just as a real pointer action does.
    await evaluate(`(() => {
      const textarea = document.querySelector('textarea.source-editor')
      if (!textarea) return false
      textarea.focus()
      textarea.__horsemdSourceSelectionUser = true
      textarea.scrollTop = 0
      return true
    })()`)
    await sleep(100)
    await assertLeadingSourceCaret({ evaluate, send }, 'textarea.source-editor', '## 页面对应关系')
    await toggleNormalSourceMode({ evaluate, send })
    await waitFor(
      () => evaluate(`!document.querySelector('textarea.source-editor') && !![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'Second source/rich control click did not return to single rich view'
    )

    console.log('PASS source + rich split UI: context entry, source-only editing, leading caret, matched scroll room, preview contract, save, 10 scroll links, close')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
